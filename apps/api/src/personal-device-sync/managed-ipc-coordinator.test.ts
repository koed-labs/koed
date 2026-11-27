import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbPool } from "@koed-labs/db";
import { storeDesktopLocalCredential } from "@koed-labs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildServer,
  type BuildServerOptions
} from "../server/build-server.js";
import { createManagedIpcCoordinator } from "./managed-ipc-coordinator.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tick = () => new Promise<void>((done) => setImmediate(done));
class Endpoint extends EventEmitter {
  connected = true;
  sent: Array<Record<string, any>> = [];
  failNextSend = false;
  send(wire: string, callback: (error: Error | null) => void) {
    this.sent.push(JSON.parse(wire));
    const error = this.failNextSend ? new Error("send failed") : null;
    this.failNextSend = false;
    callback(error);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit("disconnect");
  }
  request(seq: number, op: string, args = {}) {
    this.emit(
      "message",
      JSON.stringify({ v: 1, type: "request", seq, op, args })
    );
  }
}
const homes: string[] = [];
const previous = {
  home: process.env.KOED_HOME,
  profile: process.env.KOED_DEPLOYMENT_PROFILE
};
function setup(getUser: (id: string) => Promise<unknown>) {
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "managed-ipc-"));
  homes.push(home);
  process.env.KOED_HOME = home;
  process.env.KOED_DEPLOYMENT_PROFILE = "local_personal";
  const repository = {
    getUser,
    wakePdsLocalSync: async () => {}
  } as BuildServerOptions["repository"];
  return { home, repository: repository!, endpoint: new Endpoint() };
}
afterEach(() => {
  if (previous.home === undefined) delete process.env.KOED_HOME;
  else process.env.KOED_HOME = previous.home;
  if (previous.profile === undefined)
    delete process.env.KOED_DEPLOYMENT_PROFILE;
  else process.env.KOED_DEPLOYMENT_PROFILE = previous.profile;
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

async function registerOperation(endpoint: Endpoint) {
  endpoint.request(1, "bind");
  await vi.waitFor(() => expect(endpoint.sent[1]?.op).toBe("bind"));
  endpoint.request(2, "bindAck", {
    challenge: endpoint.sent[1].result.challenge
  });
  await vi.waitFor(() => expect(endpoint.sent[2]?.op).toBe("bindAck"));
  endpoint.request(3, "create");
  await vi.waitFor(() => expect(endpoint.sent[3]?.op).toBe("create"));
  const { instanceId, epochId } = endpoint.sent[3].result;
  endpoint.request(4, "register", { instanceId, epochId });
  await vi.waitFor(() => expect(endpoint.sent[4]?.op).toBe("register"));
  return {
    "x-koed-enrollment-instance-id": instanceId,
    "x-koed-enrollment-epoch-id": epochId,
    "x-koed-enrollment-operation-id": endpoint.sent[4].result.operationId
  };
}

const integrationDatabaseUrl =
  process.env.KOED_OAUTH_TEST_DATABASE_URL || process.env.DATABASE_URL;

describe("managed IPC coordinator", () => {
  it.skipIf(!integrationDatabaseUrl)(
    "initializes its own database repository and binds its user",
    async () => {
      const { home, endpoint } = setup(async (id) => ({ id }));
      const database = `managed_ipc_${randomUUID().replaceAll("-", "")}`;
      const admin = createDbPool({ connectionString: integrationDatabaseUrl });
      const url = new URL(integrationDatabaseUrl!);
      url.pathname = `/${database}`;
      let coordinator:
        | Awaited<ReturnType<typeof createManagedIpcCoordinator>>
        | undefined;
      let created = false;
      try {
        await admin.query(`create database ${database}`);
        created = true;
        vi.stubEnv("DATABASE_URL", url.toString());
        coordinator = await createManagedIpcCoordinator({ endpoint });
        const fixture = createDbPool({ connectionString: url.toString() });
        try {
          await fixture.query("insert into users(id,email) values($1,$2)", [
            userId,
            "managed-ipc@example.com"
          ]);
        } finally {
          await fixture.end();
        }
        storeDesktopLocalCredential(home, {
          ownerUserId: userId,
          operationFamilies: ["personal_collaboration_write"]
        });
        await registerOperation(endpoint);
        expect(endpoint.connected).toBe(true);
      } finally {
        await coordinator?.close();
        vi.unstubAllEnvs();
        if (created) await admin.query(`drop database ${database}`);
        await admin.end();
      }
    },
    60000
  );
  it("observes the exact injected repository synchronously during server construction", async () => {
    const { repository } = setup(async (id) => ({ id }));
    const observed: unknown[] = [];
    const app = await buildServer({
      repository,
      onRepositoryReady: (value) => {
        observed.push(value);
      }
    });
    try {
      expect(observed).toEqual([repository]);
    } finally {
      await app.close();
    }
  });

  it("fails closed without a database or injected repository", async () => {
    const { endpoint } = setup(async (id) => ({ id }));
    vi.stubEnv("DATABASE_URL", "");
    try {
      await expect(createManagedIpcCoordinator({ endpoint })).rejects.toThrow(
        "repository"
      );
      expect(endpoint.sent).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not permit server options to override the repository observer", async () => {
    const { repository, endpoint } = setup(async (id) => ({ id }));
    const observer = vi.fn();
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository,
      serverOptions: { onRepositoryReady: observer } as BuildServerOptions
    });
    try {
      expect(observer).not.toHaveBeenCalled();
      expect(endpoint.sent[0].type).toBe("ready");
    } finally {
      await coordinator.close();
    }
  });
  it.each([0, 2147483647])(
    "accepts close timeout boundary %i",
    async (timeout) => {
      const { repository, endpoint } = setup(async (id) => ({ id }));
      const coordinator = await createManagedIpcCoordinator({
        endpoint,
        repository
      });
      const result = await coordinator.close(timeout);
      await result.settled;
      expect(["settled", "uncertain"]).toContain(result.status);
    }
  );

  it("rejects timeout above Node timer limit without starting close", async () => {
    const { repository, endpoint } = setup(async (id) => ({ id }));
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      await expect(coordinator.close(2147483648)).rejects.toThrow(
        "Invalid managed IPC close timeout"
      );
      expect(endpoint.connected).toBe(true);
    } finally {
      await coordinator.close();
    }
  });

  it("reports close hook failure to callback exactly once and rejects promise close", async () => {
    const { repository, endpoint } = setup(async (id) => ({ id }));
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    const failure = new Error("close hook failed");
    coordinator.app.addHook("onClose", async () => {
      throw failure;
    });
    const callback = vi.fn();
    (
      coordinator.app.close as unknown as (
        callback: (error?: Error) => void
      ) => void
    )(callback);
    await expect(coordinator.close()).rejects.toBe(failure);
    await expect(coordinator.app.close()).rejects.toBe(failure);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith(failure);
    await tick();
    expect(callback).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "poison", "error", "send failure", "finish"])(
    "denies registered tagged work after %s",
    async (mode) => {
      const { home, repository, endpoint } = setup(async (id) => ({ id }));
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: userId,
        operationFamilies: ["personal_collaboration_write"]
      });
      const coordinator = await createManagedIpcCoordinator({
        endpoint,
        repository
      });
      try {
        const headers = {
          authorization: credential.authorization,
          ...(await registerOperation(endpoint))
        };
        const request = () =>
          coordinator.app.inject({
            method: "POST",
            url: "/v1/personal-device-sync/local-runtime-wake",
            headers
          });
        expect((await request()).statusCode).toBe(200);
        if (mode === "disconnect") endpoint.disconnect();
        else if (mode === "poison") endpoint.emit("message", "invalid");
        else if (mode === "error")
          endpoint.emit("error", new Error("IPC failure"));
        else if (mode === "send failure") {
          endpoint.failNextSend = true;
          endpoint.request(5, "create");
          await vi.waitFor(() => expect(endpoint.connected).toBe(false));
        } else {
          endpoint.request(5, "finish");
          await vi.waitFor(() => expect(endpoint.connected).toBe(false));
        }
        expect((await request()).statusCode).not.toBe(200);
      } finally {
        await coordinator.close();
      }
    }
  );

  it("does not claim previously admitted work stopped on channel loss", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const { home, repository, endpoint } = setup(async (id) => ({ id }));
    repository.wakePdsLocalSync = async () => {
      entered();
      await blocked;
    };
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      const headers = {
        authorization: credential.authorization,
        ...(await registerOperation(endpoint))
      };
      const request = () =>
        coordinator.app.inject({
          method: "POST",
          url: "/v1/personal-device-sync/local-runtime-wake",
          headers
        });
      const pending = request();
      await started;
      endpoint.disconnect();
      expect((await request()).statusCode).not.toBe(200);
      release();
      expect((await pending).statusCode).toBe(200);
    } finally {
      release();
      await coordinator.close();
    }
  });

  it("denies work when the endpoint is already disconnected without an event", async () => {
    const { home, repository, endpoint } = setup(async (id) => ({ id }));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const options = { endpoint, repository };
    const coordinator = await createManagedIpcCoordinator(options);
    try {
      const headers = {
        authorization: credential.authorization,
        ...(await registerOperation(endpoint))
      };
      options.endpoint = new Endpoint();
      endpoint.connected = false;
      const response = await coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers
      });
      expect(response.statusCode).not.toBe(200);
    } finally {
      await coordinator.close();
    }
  });

  it("rechecks admission after a delayed HTTP owner lookup", async () => {
    let block = false;
    let release!: (value: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(async (id) => {
      if (block) {
        block = false;
        entered();
        return new Promise((done) => {
          release = done;
        });
      }
      return { id };
    });
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      const headers = {
        authorization: credential.authorization,
        ...(await registerOperation(endpoint))
      };
      block = true;
      const pending = coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers
      });
      await started;
      endpoint.disconnect();
      release({ id: userId });
      expect((await pending).statusCode).not.toBe(200);
    } finally {
      await coordinator.close();
    }
  });

  it("denies registered work at start of direct app.close", async () => {
    let block = false;
    let release!: (value: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(async (id) => {
      if (block) {
        block = false;
        entered();
        return new Promise((done) => {
          release = done;
        });
      }
      return { id };
    });
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    const headers = {
      authorization: credential.authorization,
      ...(await registerOperation(endpoint))
    };
    block = true;
    endpoint.request(5, "create");
    await started;
    const closing = coordinator.app.close();
    const response = await coordinator.app.inject({
      method: "POST",
      url: "/v1/personal-device-sync/local-runtime-wake",
      headers
    });
    expect(response.statusCode).not.toBe(200);
    release({ id: userId });
    await closing;
  });

  it("denies registered tagged work during stalled close and reports uncertainty until cleanup settles", async () => {
    let block = false;
    let release!: (value: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(async (id) => {
      if (block) {
        block = false;
        entered();
        return new Promise((done) => {
          release = done;
        });
      }
      return { id };
    });
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    let resourcesClosed = false;
    coordinator.app.addHook("onClose", async () => {
      resourcesClosed = true;
    });
    const headers = {
      authorization: credential.authorization,
      ...(await registerOperation(endpoint))
    };
    const request = () =>
      coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers
      });
    expect((await request()).statusCode).toBe(200);
    block = true;
    endpoint.request(5, "create");
    await started;
    const closing = coordinator.close(20);
    expect((await request()).statusCode).not.toBe(200);
    const result = await closing;
    expect(result.status).toBe("uncertain");
    let settled = false;
    void result.settled.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    expect(resourcesClosed).toBe(false);
    release({ id: userId });
    await result.settled;
    expect(settled).toBe(true);
    expect(resourcesClosed).toBe(true);
  });

  it("fails construction when the IPC channel is disconnected", async () => {
    const { repository, endpoint } = setup(async (id) => ({ id }));
    endpoint.connected = false;
    await expect(
      createManagedIpcCoordinator({ endpoint, repository })
    ).rejects.toThrow();
  });

  it("shares IPC-created operations with managed HTTP admission and denies HTTP control", async () => {
    const { home, repository, endpoint } = setup(async (id) => ({ id }));
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      expect(endpoint.sent[0].type).toBe("ready");
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: userId,
        operationFamilies: ["personal_collaboration_write"]
      });
      endpoint.request(1, "bind");
      await vi.waitFor(() => expect(endpoint.sent[1]?.op).toBe("bind"));
      endpoint.request(2, "bindAck", {
        challenge: (endpoint.sent[1].result as any).challenge
      });
      await vi.waitFor(() => expect(endpoint.sent[2]?.op).toBe("bindAck"));
      endpoint.request(3, "create");
      await vi.waitFor(() => expect(endpoint.sent[3]?.op).toBe("create"));
      const { instanceId, epochId } = endpoint.sent[3].result as any;
      expect(instanceId).toBe(endpoint.sent[0].instanceId);
      endpoint.request(4, "register", { instanceId, epochId });
      await vi.waitFor(() => expect(endpoint.sent[4]?.op).toBe("register"));
      const { operationId } = endpoint.sent[4].result as any;
      const authorization = credential.authorization;
      const control = await coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/enrollment-epochs",
        headers: { authorization },
        payload: {}
      });
      expect(control.statusCode).toBe(403);
      const untagged = await coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers: { authorization }
      });
      expect(untagged.statusCode).toBe(403);
      const tagged = await coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers: {
          authorization,
          "x-koed-enrollment-instance-id": instanceId,
          "x-koed-enrollment-epoch-id": epochId,
          "x-koed-enrollment-operation-id": operationId
        }
      });
      expect(tagged.statusCode, tagged.body).toBe(200);
      endpoint.request(5, "fenceEpoch", { instanceId, epochId });
      await vi.waitFor(() => expect(endpoint.sent[5]?.op).toBe("fenceEpoch"));
      const stale = await coordinator.app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers: {
          authorization,
          "x-koed-enrollment-instance-id": instanceId,
          "x-koed-enrollment-epoch-id": epochId,
          "x-koed-enrollment-operation-id": operationId
        }
      });
      expect(stale.statusCode).toBe(409);
      endpoint.request(6, "bind");
      expect(endpoint.connected).toBe(false);
    } finally {
      await coordinator.close();
    }
  });

  it("retains delayed initial binding after uncertain close and reports late cleanup failure", async () => {
    let release!: (user: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(() => {
      entered();
      return new Promise((done) => {
        release = done;
      });
    });
    storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    const failure = new Error("late close hook failed");
    let hookStarted = false;
    coordinator.app.addHook("onClose", async () => {
      hookStarted = true;
      throw failure;
    });
    endpoint.request(1, "bind");
    await started;
    const result = await coordinator.close(10);
    expect(result.status).toBe("uncertain");
    expect(hookStarted).toBe(false);
    const rejected = expect(result.settled).rejects.toBe(failure);
    release({ id: userId });
    await rejected;
    expect(hookStarted).toBe(true);
    expect(endpoint.sent).toHaveLength(1);
    await expect(coordinator.close()).rejects.toBe(failure);
  });

  it("poisons a timed-out initial bind and never publishes a late binding", async () => {
    let release!: (user: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(() => {
      entered();
      return new Promise((done) => {
        release = done;
      });
    });
    storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      vi.useFakeTimers();
      endpoint.request(1, "bind");
      await started;
      await vi.advanceTimersByTimeAsync(5000);
      expect(endpoint.connected).toBe(false);
      release({ id: userId });
    } finally {
      vi.useRealTimers();
      await coordinator.close();
    }
    expect(endpoint.sent).toHaveLength(1);
  });

  it("waits for delayed owner lookup after cancellation and never publishes binding", async () => {
    let release!: (user: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(() => {
      entered();
      return new Promise((done) => {
        release = done;
      });
    });
    storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    endpoint.request(1, "bind");
    await started;
    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    release({ id: userId });
    await closing;
    expect(endpoint.sent).toHaveLength(1);
  });

  it.each([null, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }])(
    "rejects inactive or mismatched owner %s",
    async (user) => {
      const { home, repository, endpoint } = setup(async () => user);
      storeDesktopLocalCredential(home, {
        ownerUserId: userId,
        operationFamilies: ["personal_collaboration_write"]
      });
      const coordinator = await createManagedIpcCoordinator({
        endpoint,
        repository
      });
      try {
        endpoint.request(1, "bind");
        await vi.waitFor(() => expect(endpoint.connected).toBe(false));
        expect(endpoint.sent).toHaveLength(1);
      } finally {
        await coordinator.close();
      }
    }
  );

  it("rejects bind when no local custody exists", async () => {
    const { repository, endpoint } = setup(async (id) => ({ id }));
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      endpoint.request(1, "bind");
      await vi.waitFor(() => expect(endpoint.connected).toBe(false));
      expect(endpoint.sent).toHaveLength(1);
    } finally {
      await coordinator.close();
    }
  });

  it("keeps binding tied to the server repository if caller changes options", async () => {
    const { home, repository, endpoint } = setup(async (id) => ({ id }));
    storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const options = { endpoint, repository };
    const coordinator = await createManagedIpcCoordinator(options);
    try {
      options.repository = {
        getUser: async () => null
      } as unknown as typeof repository;
      endpoint.request(1, "bind");
      await vi.waitFor(() => expect(endpoint.sent[1]?.op).toBe("bind"));
      expect(endpoint.connected).toBe(true);
    } finally {
      await coordinator.close();
    }
  });

  it("rejects credentials supplied in the bind request", async () => {
    const { home, repository, endpoint } = setup(async (id) => ({ id }));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    try {
      endpoint.request(1, "bind", { authorization: credential.authorization });
      expect(endpoint.connected).toBe(false);
      expect(endpoint.sent).toHaveLength(1);
    } finally {
      await coordinator.close();
    }
  });

  it("rejects a second bind while the first lookup is pending", async () => {
    let release!: (user: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const { home, repository, endpoint } = setup(() => {
      entered();
      return new Promise((done) => {
        release = done;
      });
    });
    storeDesktopLocalCredential(home, {
      ownerUserId: userId,
      operationFamilies: ["personal_collaboration_write"]
    });
    const coordinator = await createManagedIpcCoordinator({
      endpoint,
      repository
    });
    endpoint.request(1, "bind");
    await started;
    endpoint.request(2, "bind");
    expect(endpoint.connected).toBe(false);
    release({ id: userId });
    await coordinator.close();
    expect(endpoint.sent).toHaveLength(1);
  });
});
