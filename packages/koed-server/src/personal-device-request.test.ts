import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { networkInterfaces } from "node:os";
import { request as httpRequest, Server } from "node:http";
import { join } from "node:path";
import {
  createPdsApplicationSecretStore,
  isPrivateNetworkIpv4Address
} from "@koed-labs/shared";
import { resolveKoedServerPaths } from "./paths.js";
import {
  startDeviceRequestService,
  deviceRequestCommand,
  exchangeDeviceRequest,
  parseDeviceRequestLink,
  resolveDeviceRequestHost,
  DeviceRequestStartupUncertainError
} from "./personal-device-request.js";
import { encryptPersonalDevicePairingMessage } from "./personal-device-request-crypto.js";

const storage = vi.hoisted(() => ({ failPut: false, failAfterPut: false }));
vi.mock("@koed-labs/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@koed-labs/shared")>();
  return {
    ...original,
    createPdsApplicationSecretStore: (
      ...args: Parameters<typeof original.createPdsApplicationSecretStore>
    ) => {
      const store = original.createPdsApplicationSecretStore(...args);
      return {
        ...store,
        put: (...values: Parameters<typeof store.put>) => {
          if (storage.failPut) throw new Error("storage failure");
          const result = store.put(...values);
          if (storage.failAfterPut) throw new Error("storage failure");
          return result;
        }
      };
    }
  };
});

const addresses = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .filter(
    (entry) =>
      entry.family === "IPv4" &&
      !entry.internal &&
      isPrivateNetworkIpv4Address(entry.address)
  )
  .map((entry) => entry.address);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  storage.failPut = false;
  storage.failAfterPut = false;
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const setup = async (
  redeem = vi.fn(async () => {}),
  enrolled = vi.fn(async () => false),
  availableAddresses = addresses,
  managedEnrollment?: {
    createEpoch: () => Promise<{ instanceId: string; epochId: string }>;
    register: (epoch: {
      instanceId: string;
      epochId: string;
    }) => Promise<{ instanceId: string; epochId: string; operationId: string }>;
  }
) => {
  const home = mkdtempSync("/tmp/koed-request-");
  const paths = resolveKoedServerPaths({ KOED_HOME: home });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const service = await startDeviceRequestService({
    paths,
    redeem,
    enrolled,
    addresses: () => availableAddresses,
    ...(managedEnrollment ? { managedEnrollment } : {})
  });
  cleanups.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => service.close()
  );
  return { home, paths, service, redeem, enrolled };
};
describe("device request links", () => {
  it.each([
    "http://8.8.8.8:3310/device-request/",
    "http://127.0.0.1:3310/device-request/",
    "https://example.com/pair",
    "http://user:pass@192.168.0.2:3310/device-request/",
    "file:///tmp/request"
  ])("rejects unsafe destinations: %s", (value) => {
    expect(() => parseDeviceRequestLink(value)).toThrow();
  });
});
describe("supervisor device requests with loopback transport", () => {
  const privateAddress = "10.42.0.1";
  it("retries a public bind failure without returning a port zero link", async () => {
    const { paths, service } = await setup(undefined, undefined, [
      privateAddress
    ]);
    const original = Server.prototype.listen;
    let fail = true;
    const spy = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementation(function (this: Server, ...args: unknown[]) {
        if (typeof args[0] === "number" && args[1] === privateAddress) {
          if (fail) {
            fail = false;
            queueMicrotask(() => this.emit("error", new Error("bind failure")));
            return this;
          }
          args[1] = "127.0.0.1";
        }
        return Reflect.apply(original, this, args) as Server;
      } as typeof Server.prototype.listen);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.hostname !== privateAddress) return originalFetch(input, init);
        const headers = new Headers(init?.headers);
        headers.set("Host", url.host);
        return new Promise<Response>((resolve, reject) => {
          const request = httpRequest(
            {
              hostname: "127.0.0.1",
              port: url.port,
              path: `${url.pathname}${url.search}`,
              method: init?.method,
              headers: Object.fromEntries(headers),
              signal: init?.signal ?? undefined
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode
                  })
                )
              );
            }
          );
          request.on("error", reject);
          if (typeof init?.body !== "string") {
            request.destroy(new Error("Expected string request body"));
          } else {
            request.end(init.body);
          }
        });
      });
    try {
      await expect(deviceRequestCommand(paths, "create")).rejects.toThrow(
        "bind failure"
      );
      const retry = await deviceRequestCommand(paths, "create");
      expect(parseDeviceRequestLink(retry.link!).url.port).not.toBe("0");
      expect(await exchangeDeviceRequest(retry.link!, "inspect")).toMatchObject(
        {
          state: "waiting"
        }
      );
    } finally {
      try {
        await service.close();
      } finally {
        cleanups.pop();
        fetchSpy.mockRestore();
        spy.mockRestore();
      }
    }
  });
  it("fails closed on retry when listener state may have committed before storage error", async () => {
    const { paths, service } = await setup(undefined, undefined, [
      privateAddress
    ]);
    const original = Server.prototype.listen;
    const spy = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementation(function (this: Server, ...args: unknown[]) {
        if (typeof args[0] === "number" && args[1] === privateAddress) {
          args[1] = "127.0.0.1";
        }
        return Reflect.apply(original, this, args) as Server;
      } as typeof Server.prototype.listen);
    let closeFailureExpected = false;
    try {
      storage.failAfterPut = true;
      await expect(deviceRequestCommand(paths, "create")).rejects.toThrow(
        "storage failure"
      );
      storage.failAfterPut = false;
      closeFailureExpected = true;
      await expect(deviceRequestCommand(paths, "create")).rejects.toThrow(
        "Pairing storage unavailable."
      );
    } finally {
      try {
        if (closeFailureExpected) {
          await expect(service.close()).rejects.toThrow("cleanup incomplete");
        } else {
          await service.close();
        }
      } finally {
        cleanups.pop();
        spy.mockRestore();
      }
    }
  });
});
describe.skipIf(!addresses.length)("supervisor device requests", () => {
  it("registers managed enrollment before forwarding its operation to redemption", async () => {
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const operation = { ...epoch, operationId: "operation" };
    const order: string[] = [];
    const registration = {
      createEpoch: vi.fn(async () => {
        order.push("create");
        return epoch;
      }),
      register: vi.fn(async (received: typeof epoch) => {
        expect(received).toBe(epoch);
        order.push("register");
        return operation;
      })
    };
    const redeem = vi.fn(async (...args: unknown[]) => {
      order.push("redeem");
      expect(args[3]).toBe(operation);
    });
    const { paths } = await setup(redeem, undefined, addresses, registration);
    const request = await deviceRequestCommand(paths, "create", "Studio");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await vi.waitFor(() =>
      expect(order).toEqual(["create", "register", "redeem"])
    );
    expect(redeem).toHaveBeenCalledWith(
      "invitation",
      "Studio",
      expect.any(AbortSignal),
      operation
    );
  });
  it.each(["create", "register", "redeem"] as const)(
    "drains managed work interrupted during %s without taking dependency ownership",
    async (stage) => {
      const epoch = { instanceId: "instance", epochId: "epoch" };
      const operation = { ...epoch, operationId: "operation" };
      const gate = deferred<void>();
      const entered = deferred<void>();
      const pause = async (at: string) => {
        if (stage === at) {
          entered.resolve();
          await gate.promise;
        }
      };
      const registration = {
        createEpoch: vi.fn(async () => {
          await pause("create");
          return epoch;
        }),
        register: vi.fn(async () => {
          await pause("register");
          return operation;
        }),
        close: vi.fn(),
        fence: vi.fn()
      };
      const redeem = vi.fn(async () => {
        await pause("redeem");
      });
      const { paths, home, service } = await setup(
        redeem,
        undefined,
        addresses,
        registration
      );
      const request = await deviceRequestCommand(paths, "create");
      await exchangeDeviceRequest(
        request.link!,
        "accept",
        "private-invitation"
      );
      await entered.promise;
      vi.useFakeTimers();
      try {
        const close = expect(service.close()).rejects.toThrow(
          "cleanup incomplete"
        );
        await vi.advanceTimersByTimeAsync(5_100);
        await close;
        let settled = false;
        const cleanup = service.waitForCleanup().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        gate.resolve();
        await cleanup;
        expect(registration.close).not.toHaveBeenCalled();
        expect(registration.fence).not.toHaveBeenCalled();
        expect(redeem).toHaveBeenCalledTimes(stage === "redeem" ? 1 : 0);
        if (stage === "create")
          expect(registration.register).not.toHaveBeenCalled();
        const store = createPdsApplicationSecretStore({ rootPath: home });
        expect(JSON.parse(store.get("pds-device-request")!)).toMatchObject({
          state: "connecting",
          invitation: "private-invitation"
        });
        cleanups.pop();
      } finally {
        gate.resolve();
        vi.useRealTimers();
      }
    }
  );
  it.each(["create", "register", "redeem"] as const)(
    "redacts managed %s failures without untagged fallback",
    async (stage) => {
      for (const synchronous of [true, false]) {
        const epoch = { instanceId: "instance", epochId: "epoch" };
        const operation = { ...epoch, operationId: "operation" };
        const fail = () => {
          if (synchronous) throw new Error("secret-capability-url");
          return Promise.reject(new Error("secret-capability-url"));
        };
        const registration = {
          createEpoch: vi.fn(() =>
            stage === "create" ? fail() : Promise.resolve(epoch)
          ),
          register: vi.fn(() =>
            stage === "register" ? fail() : Promise.resolve(operation)
          )
        };
        const redeem = vi.fn((..._args: unknown[]) =>
          stage === "redeem" ? fail() : Promise.resolve()
        );
        const { paths, home } = await setup(
          redeem,
          undefined,
          addresses,
          registration
        );
        const request = await deviceRequestCommand(paths, "create");
        await exchangeDeviceRequest(
          request.link!,
          "accept",
          "private-invitation"
        );
        await vi.waitFor(async () =>
          expect(await deviceRequestCommand(paths, "status")).toMatchObject({
            state: "failed"
          })
        );
        expect(
          JSON.stringify(await deviceRequestCommand(paths, "status"))
        ).not.toContain("secret");
        const saved = createPdsApplicationSecretStore({ rootPath: home }).get(
          "pds-device-request"
        )!;
        expect(saved).not.toContain("private-invitation");
        expect(saved).not.toContain("secret-capability-url");
        if (stage === "redeem")
          expect(redeem).toHaveBeenCalledWith(
            "private-invitation",
            expect.any(String),
            expect.any(AbortSignal),
            operation
          );
        else expect(redeem).not.toHaveBeenCalled();
      }
    }
  );
  it("leaves uncertain registration and active API work to caller after local cleanup", async () => {
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const registrationGate = deferred<typeof epoch & { operationId: string }>();
    const entered = deferred<void>();
    const registration = {
      createEpoch: async () => epoch,
      register: () => {
        entered.resolve();
        return registrationGate.promise;
      },
      close: vi.fn(),
      fence: vi.fn()
    };
    const redeem = vi.fn(async () => {});
    const { paths, service } = await setup(
      redeem,
      undefined,
      addresses,
      registration
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    const closing = service.close();
    registrationGate.reject(new Error("uncertain acknowledgment with secret"));
    await closing;
    await service.waitForCleanup();
    expect(redeem).not.toHaveBeenCalled();
    expect(registration.close).not.toHaveBeenCalled();
    expect(registration.fence).not.toHaveBeenCalled();
  });
  it("does not fence API work that outlives locally aborted redemption", async () => {
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const operation = { ...epoch, operationId: "operation" };
    const remote = deferred<void>();
    let remoteSettled = false;
    void remote.promise.then(() => {
      remoteSettled = true;
    });
    const entered = deferred<void>();
    const registration = {
      createEpoch: async () => epoch,
      register: async () => operation,
      close: vi.fn(),
      fence: vi.fn()
    };
    const redeem = vi.fn(
      (_invitation: string, _label: string, signal: AbortSignal) => {
        entered.resolve();
        return new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }
    );
    const { paths, service } = await setup(
      redeem,
      undefined,
      addresses,
      registration
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    await service.close();
    await service.waitForCleanup();
    expect(remoteSettled).toBe(false);
    expect(registration.close).not.toHaveBeenCalled();
    expect(registration.fence).not.toHaveBeenCalled();
    remote.resolve();
    await remote.promise;
  });
  it("registers restored connecting enrollment before redemption", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const operation = { ...epoch, operationId: "operation" };
    const firstRegistration = {
      createEpoch: async () => {
        entered.resolve();
        await gate.promise;
        return epoch;
      },
      register: async () => operation
    };
    const { paths, service } = await setup(
      vi.fn(async () => {}),
      undefined,
      addresses,
      firstRegistration
    );
    const request = await deviceRequestCommand(paths, "create", "Studio");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    const close = service.close();
    gate.resolve();
    await close;
    const order: string[] = [];
    const registration = {
      createEpoch: async () => {
        order.push("create");
        return epoch;
      },
      register: async (received: typeof epoch) => {
        expect(received).toBe(epoch);
        order.push("register");
        return operation;
      }
    };
    const redeem = vi.fn(
      async (
        _invitation: string,
        _label: string,
        _signal: AbortSignal,
        received?: typeof operation
      ) => {
        expect(received).toBe(operation);
        order.push("redeem");
      }
    );
    const restarted = await startDeviceRequestService({
      paths,
      enrolled: async () => false,
      redeem,
      managedEnrollment: registration
    });
    cleanups.push(() => restarted.close());
    await vi.waitFor(() =>
      expect(order).toEqual(["create", "register", "redeem"])
    );
    expect(redeem).toHaveBeenCalledWith(
      "invitation",
      "Studio",
      expect.any(AbortSignal),
      operation
    );
  });
  it("retains local cleanup ownership after startup fails during restored registration", async () => {
    const initial = deferred<void>();
    const entered = deferred<void>();
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const operation = { ...epoch, operationId: "operation" };
    const { paths, service } = await setup(
      vi.fn(async () => {}),
      undefined,
      addresses,
      {
        createEpoch: async () => {
          entered.resolve();
          await initial.promise;
          return epoch;
        },
        register: async () => operation
      }
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    const closed = service.close();
    initial.resolve();
    await closed;
    const registrationGate = deferred<void>();
    const registerEntered = deferred<void>();
    const registration = {
      createEpoch: async () => epoch,
      register: async () => {
        registerEntered.resolve();
        await registrationGate.promise;
        return operation;
      },
      close: vi.fn(),
      fence: vi.fn()
    };
    const redeem = vi.fn(async () => {});
    const original = Server.prototype.listen;
    let failBind!: () => void;
    const spy = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementation(function (this: Server, ...args: unknown[]) {
        if (typeof args[0] === "string") {
          failBind = () => this.emit("error", new Error("local bind failure"));
          return this;
        }
        return Reflect.apply(original, this, args) as Server;
      } as typeof Server.prototype.listen);
    try {
      const starting = startDeviceRequestService({
        paths,
        enrolled: async () => false,
        redeem,
        managedEnrollment: registration
      }).catch((error: unknown) => error);
      await registerEntered.promise;
      failBind();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(5_100);
      const error = await starting;
      expect(error).toBeInstanceOf(DeviceRequestStartupUncertainError);
      let settled = false;
      const cleanup = (error as DeviceRequestStartupUncertainError).ownership
        .waitForCleanup()
        .then(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      registrationGate.resolve();
      await cleanup;
      expect(redeem).not.toHaveBeenCalled();
      expect(registration.close).not.toHaveBeenCalled();
      expect(registration.fence).not.toHaveBeenCalled();
    } finally {
      registrationGate.resolve();
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
  it("requires explicit acceptance and completes only after reconciliation", async () => {
    let complete!: () => void;
    const redeem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const { paths, home } = await setup(redeem);
    const request = await deviceRequestCommand(paths, "create", "Studio");
    expect(request.link).toBeTruthy();
    expect(await exchangeDeviceRequest(request.link!, "inspect")).toMatchObject(
      { label: "Studio", state: "waiting" }
    );
    expect(redeem).not.toHaveBeenCalled();
    const status = await deviceRequestCommand(paths, "status");
    expect(status).not.toHaveProperty("link");
    const { token } = parseDeviceRequestLink(request.link!);
    expect(
      readFileSync(join(home, "secrets", "pds-secrets.json"), "utf8")
    ).not.toContain(token);
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    expect(redeem).toHaveBeenCalledWith(
      "private-invitation",
      "Studio",
      expect.any(AbortSignal)
    );
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "connecting"
    });
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "another-invitation")
    ).rejects.toThrow();
    complete();
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "connected"
      })
    );
  });
  it.each([
    { outcome: "success", state: "connected" },
    { outcome: "failure", state: "failed" }
  ])(
    "retains persistence failure after enrollment $outcome",
    async ({ outcome, state }) => {
      let finish!: () => void;
      const { paths, service } = await setup(
        vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              finish = () =>
                outcome === "success"
                  ? resolve()
                  : reject(new Error("private redemption error"));
            })
        )
      );
      const request = await deviceRequestCommand(paths, "create");
      await exchangeDeviceRequest(request.link!, "accept", "invitation");
      storage.failPut = true;
      finish();
      await vi.waitFor(async () =>
        expect(await deviceRequestCommand(paths, "status")).toMatchObject({
          state
        })
      );
      await expect(service.close()).rejects.toThrow("cleanup incomplete");
      await expect(service.waitForCleanup()).rejects.toMatchObject({
        quiescence: "proven"
      });
      cleanups.pop();
    }
  );
  it("fails closed after acceptance persistence fails", async () => {
    const { paths, service, redeem } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    storage.failPut = true;
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "invitation")
    ).rejects.toThrow();
    storage.failPut = false;
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "waiting"
    });
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "invitation")
    ).rejects.toThrow();
    expect(redeem).not.toHaveBeenCalled();
    await expect(service.close()).rejects.toThrow("cleanup incomplete");
    await expect(service.waitForCleanup()).rejects.toMatchObject({
      quiescence: "proven"
    });
    cleanups.pop();
    const restarted = await startDeviceRequestService({
      paths,
      redeem,
      enrolled: async () => false,
      addresses: () => addresses
    });
    cleanups.push(() => restarted.close());
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "waiting"
    });
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
  });
  it("reports cancellation persistence failure without publishing cancellation", async () => {
    const { paths, service } = await setup();
    await deviceRequestCommand(paths, "create");
    storage.failPut = true;
    await expect(deviceRequestCommand(paths, "cancel")).rejects.toThrow();
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "waiting"
    });
    await expect(service.close()).rejects.toThrow("cleanup incomplete");
    await expect(service.waitForCleanup()).rejects.toMatchObject({
      quiescence: "proven"
    });
    cleanups.pop();
  });
  it("reports expiry persistence failure without publishing expiry", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const { paths, service } = await setup();
    const expire = interval.mock.calls.at(-1)![0] as () => void;
    interval.mockRestore();
    await deviceRequestCommand(paths, "create");
    storage.failPut = true;
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    try {
      expire();
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "waiting"
      });
      await expect(service.close()).rejects.toThrow("cleanup incomplete");
      await expect(service.waitForCleanup()).rejects.toMatchObject({
        quiescence: "proven"
      });
      cleanups.pop();
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
  });
  it.each(["unmanaged", "managed"] as const)(
    "shares close and cleanup ownership when %s abort listeners reenter shutdown",
    async (mode) => {
      const gate = deferred<void>();
      const entered = deferred<void>();
      let reentrantClose!: Promise<void>;
      let reentrantCleanup!: Promise<void>;
      const redeem = vi.fn(
        (_invitation: string, _label: string, signal: AbortSignal) => {
          signal.addEventListener(
            "abort",
            () => {
              reentrantClose = service.close();
              reentrantCleanup = service.waitForCleanup();
            },
            { once: true }
          );
          entered.resolve();
          return gate.promise;
        }
      );
      const epoch = { instanceId: "instance", epochId: "epoch" };
      const registration = {
        createEpoch: async () => epoch,
        register: async () => ({ ...epoch, operationId: "operation" })
      };
      const started = await setup(
        redeem,
        undefined,
        addresses,
        mode === "managed" ? registration : undefined
      );
      const { service } = started;
      const request = await deviceRequestCommand(started.paths, "create");
      await exchangeDeviceRequest(request.link!, "accept", "invitation");
      await entered.promise;
      const closing = service.close();
      let cleanupSettled = false;
      void reentrantCleanup.then(() => {
        cleanupSettled = true;
      });
      try {
        expect(reentrantClose).toBe(closing);
        await Promise.resolve();
        expect(cleanupSettled).toBe(false);
      } finally {
        gate.resolve();
        await Promise.all([closing, reentrantClose, reentrantCleanup]);
      }
    }
  );
  it("keeps reentrant cleanup ownership after close times out", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let reentrantClose!: Promise<void>;
    let reentrantCleanup!: Promise<void>;
    const redeem = (
      _invitation: string,
      _label: string,
      signal: AbortSignal
    ) => {
      signal.addEventListener(
        "abort",
        () => {
          reentrantClose = service.close();
          reentrantCleanup = service.waitForCleanup();
        },
        { once: true }
      );
      entered.resolve();
      return gate.promise;
    };
    const epoch = { instanceId: "instance", epochId: "epoch" };
    const registration = {
      createEpoch: async () => epoch,
      register: async () => ({ ...epoch, operationId: "operation" }),
      close: vi.fn(),
      fence: vi.fn()
    };
    const { paths, service } = await setup(
      redeem,
      undefined,
      addresses,
      registration
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    vi.useFakeTimers();
    try {
      const closing = service.close();
      const outcomes = Promise.allSettled([closing, reentrantClose]);
      let cleanupSettled = false;
      const cleanup = reentrantCleanup.then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(5_100);
      const [outer, inner] = await outcomes;
      expect(reentrantClose).toBe(closing);
      expect(outer.status).toBe("rejected");
      expect(inner.status).toBe("rejected");
      if (outer.status !== "rejected" || inner.status !== "rejected")
        throw new Error("close unexpectedly succeeded");
      expect(inner.reason).toBe(outer.reason);
      expect(outer.reason).toBeInstanceOf(AggregateError);
      expect(cleanupSettled).toBe(false);
      expect(registration.close).not.toHaveBeenCalled();
      expect(registration.fence).not.toHaveBeenCalled();
      gate.resolve();
      await cleanup;
      await expect(service.waitForCleanup()).resolves.toBeUndefined();
      cleanups.pop();
    } finally {
      gate.resolve();
      vi.useRealTimers();
    }
  });
  it("reports uncertain reentrant cleanup failure and permits retry", async () => {
    const entered = deferred<void>();
    let reentrantClose!: Promise<void>;
    let reentrantCleanup!: Promise<void>;
    const redeem = (
      _invitation: string,
      _label: string,
      signal: AbortSignal
    ) => {
      signal.addEventListener(
        "abort",
        () => {
          reentrantClose = service.close();
          reentrantCleanup = service.waitForCleanup();
        },
        { once: true }
      );
      entered.resolve();
      return new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    };
    const { paths, service } = await setup(redeem);
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await entered.promise;
    const original = Server.prototype.close;
    let fail = true;
    const spy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (fail && this.address() && typeof this.address() === "object") {
          queueMicrotask(() => callback?.(new Error("listener close failed")));
          return this;
        }
        return original.call(this, callback);
      });
    try {
      const closing = service.close();
      const [outer, inner, cleanup] = await Promise.allSettled([
        closing,
        reentrantClose,
        reentrantCleanup
      ]);
      expect(reentrantClose).toBe(closing);
      expect(outer.status).toBe("rejected");
      expect(inner.status).toBe("rejected");
      expect(cleanup.status).toBe("rejected");
      if (
        outer.status !== "rejected" ||
        inner.status !== "rejected" ||
        cleanup.status !== "rejected"
      )
        throw new Error("cleanup unexpectedly succeeded");
      expect(inner.reason).toBe(outer.reason);
      expect(outer.reason).toBeInstanceOf(AggregateError);
      expect(cleanup.reason).toMatchObject({ quiescence: "uncertain" });
      fail = false;
      await expect(service.waitForCleanup()).resolves.toBeUndefined();
      cleanups.pop();
    } finally {
      fail = false;
      spy.mockRestore();
    }
  });
  it("waits for aborted enrollment before close resolves", async () => {
    let complete!: () => void;
    let signal!: AbortSignal;
    const redeem = vi.fn(
      (_invitation: string, _label: string, received: AbortSignal) => {
        signal = received;
        return new Promise<void>((resolve) => {
          complete = resolve;
        });
      }
    );
    const { paths, service } = await setup(redeem);
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    complete();
    await closing;
  });
  it("reports uncertain cleanup when enrollment ignores abort", async () => {
    let complete!: () => void;
    const redeem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const { paths, service } = await setup(redeem);
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    await vi.waitFor(() => expect(redeem).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    try {
      const closing = service.close();
      const failed = expect(closing).rejects.toThrow("cleanup incomplete");
      await vi.advanceTimersByTimeAsync(5_100);
      await failed;
      await expect(service.close()).rejects.toThrow("cleanup incomplete");
      complete();
    } finally {
      vi.useRealTimers();
      // A failed close remains failed, including during test cleanup.
      cleanups.pop();
    }
  });
  it("retries listener close even when mutation drain times out", async () => {
    let unblock!: (value: boolean) => void;
    let block = false;
    const enrolled = vi.fn(() =>
      block
        ? new Promise<boolean>((resolve) => {
            unblock = resolve;
          })
        : Promise.resolve(false)
    );
    const { paths, service } = await setup(
      vi.fn(async () => {}),
      enrolled
    );
    const request = await deviceRequestCommand(paths, "create");
    block = true;
    const command = deviceRequestCommand(paths, "create").catch(
      () => undefined
    );
    await vi.waitFor(() => expect(unblock).toBeTypeOf("function"));
    const original = Server.prototype.close;
    let failed = false;
    const close = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (!failed && typeof this.address() === "object") {
          failed = true;
          queueMicrotask(() => callback?.(new Error("close failed")));
          return this;
        }
        return original.call(this, callback);
      });
    vi.useFakeTimers();
    try {
      const closing = service.close();
      const rejected = expect(closing).rejects.toThrow("cleanup incomplete");
      await vi.advanceTimersByTimeAsync(5_100);
      await rejected;
      await expect(
        exchangeDeviceRequest(request.link!, "inspect")
      ).rejects.toThrow();
      unblock(false);
      await command;
      cleanups.pop();
    } finally {
      close.mockRestore();
      vi.useRealTimers();
    }
  });
  it("waits for enrollment even when listener cleanup repeatedly fails", async () => {
    let finish!: () => void;
    const { paths, service } = await setup(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    const original = Server.prototype.close;
    let fail = true;
    const spy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (fail && this.address() && typeof this.address() === "object") {
          queueMicrotask(() => callback?.(new Error("close failed")));
          return this;
        }
        return original.call(this, callback);
      });
    vi.useFakeTimers();
    try {
      const closed = expect(service.close()).rejects.toThrow(
        "cleanup incomplete"
      );
      await vi.advanceTimersByTimeAsync(5_100);
      await closed;
      let settled = false;
      const first = service.waitForCleanup();
      const second = service.waitForCleanup();
      expect(first).toBe(second);
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      finish();
      await expect(first).rejects.toMatchObject({ quiescence: "uncertain" });
      await expect(second).rejects.toMatchObject({ quiescence: "uncertain" });
      fail = false;
      await service.waitForCleanup();
      cleanups.pop();
    } finally {
      finish();
      fail = false;
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("waits for an active close before retrying cleanup", async () => {
    const { paths, service } = await setup();
    await deviceRequestCommand(paths, "create");
    const original = Server.prototype.close;
    let release!: () => void;
    let publicCalls = 0;
    const spy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (typeof this.address() === "object" && this.address() !== null) {
          publicCalls++;
          if (publicCalls === 1) {
            release = () => {
              release = undefined!;
              original.call(this, callback);
            };
            return this;
          }
        }
        return original.call(this, callback);
      });
    try {
      const closing = service.close();
      const retry = service.waitForCleanup();
      await Promise.resolve();
      await Promise.resolve();
      expect(publicCalls).toBe(1);
      release();
      await closing;
      await retry;
    } finally {
      if (release) release();
      spy.mockRestore();
    }
  });
  it("does not close a listener twice while a timed-out close is still pending", async () => {
    const { paths, service } = await setup();
    await deviceRequestCommand(paths, "create");
    const original = Server.prototype.close;
    let release: (() => void) | undefined;
    let calls = 0;
    const spy = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (this.address() && typeof this.address() === "object") {
          calls++;
          if (calls === 1) {
            release = () => {
              release = undefined;
              original.call(this, callback);
            };
            return this;
          }
        }
        return original.call(this, callback);
      });
    vi.useFakeTimers();
    try {
      const closed = expect(service.close()).rejects.toThrow(
        "cleanup incomplete"
      );
      await vi.advanceTimersByTimeAsync(10_100);
      await closed;
      const retry = service.waitForCleanup();
      await Promise.resolve();
      expect(calls).toBe(1);
      release!();
      await retry;
      cleanups.pop();
    } finally {
      release?.();
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("retains a listener that finishes opening after mutation drain times out", async () => {
    const { paths, service } = await setup();
    const originalEmit = Server.prototype.emit;
    const originalClose = Server.prototype.close;
    let release: (() => void) | undefined;
    let listener: Server | undefined;
    let closeFailed = false;
    const emit = vi
      .spyOn(Server.prototype, "emit")
      .mockImplementation(function (
        this: Server,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (
          event === "listening" &&
          this.address() &&
          typeof this.address() === "object" &&
          !listener
        ) {
          listener = this;
          release = () => {
            release = undefined;
            Reflect.apply(originalEmit, this, [event, ...args]);
          };
          return true;
        }
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      });
    const close = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (this === listener && !closeFailed) {
          closeFailed = true;
          queueMicrotask(() => callback?.(new Error("late close failed")));
          return this;
        }
        return originalClose.call(this, callback);
      });
    const command = deviceRequestCommand(paths, "create").catch(
      () => undefined
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const address = listener!.address();
      if (!address || typeof address === "string")
        throw new Error("missing listener");
      vi.useFakeTimers();
      const closed = expect(service.close()).rejects.toThrow(
        "cleanup incomplete"
      );
      await vi.advanceTimersByTimeAsync(5_100);
      await closed;
      release!();
      await command;
      await service.waitForCleanup();
      await expect(
        fetch(`http://${addresses[0]}:${address.port}/`)
      ).rejects.toThrow();
      cleanups.pop();
    } finally {
      release?.();
      emit.mockRestore();
      close.mockRestore();
      vi.useRealTimers();
    }
  });
  it("retains listener ownership after repeated close failures", async () => {
    const { paths, service } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    const original = Server.prototype.close;
    let failures = 0;
    const close = vi
      .spyOn(Server.prototype, "close")
      .mockImplementation(function (this: Server, callback) {
        if (failures < 2 && typeof this.address() === "object") {
          failures++;
          queueMicrotask(() => callback?.(new Error("close failed")));
          return this;
        }
        return original.call(this, callback);
      });
    try {
      await expect(service.close()).rejects.toThrow("cleanup incomplete");
      await service.waitForCleanup();
      await expect(
        exchangeDeviceRequest(request.link!, "inspect")
      ).rejects.toThrow();
      cleanups.pop();
    } finally {
      close.mockRestore();
    }
  });
  it.each(["null", "{}", "[]", '"invalid"'])(
    "deletes invalid parsed saved request %s",
    async (saved) => {
      const { paths, home, service } = await setup();
      await service.close();
      const store = createPdsApplicationSecretStore({ rootPath: home });
      store.put("pds-device-request", saved);
      const restarted = await startDeviceRequestService({
        paths,
        enrolled: async () => false,
        redeem: async () => {}
      });
      try {
        expect(store.get("pds-device-request")).toBeFalsy();
      } finally {
        await restarted.close();
      }
    }
  );
  it("preserves saved request when expiring it cannot be persisted", async () => {
    const { paths, service, home } = await setup();
    await deviceRequestCommand(paths, "create");
    await service.close();
    const file = join(home, "secrets", "pds-secrets.json");
    const before = readFileSync(file, "utf8");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    storage.failPut = true;
    try {
      await expect(
        startDeviceRequestService({
          paths,
          enrolled: async () => false,
          redeem: async () => {}
        })
      ).rejects.toThrow("storage failure");
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      now.mockRestore();
    }
  });
  it("drains restored enrollment and closes its listener when local socket setup fails", async () => {
    const { paths, service } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    let finishFirst!: () => void;
    // Persist a connecting request for the next service instance.
    await service.close();
    const first = await startDeviceRequestService({
      paths,
      enrolled: async () => false,
      addresses: () => addresses,
      redeem: () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    });
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    const firstClose = first.close();
    finishFirst();
    await firstClose;
    writeFileSync(join(paths.runDir, "device-request.sock"), "unsafe");
    let finish!: () => void;
    let signal!: AbortSignal;
    let settled = false;
    const starting = startDeviceRequestService({
      paths,
      enrolled: async () => false,
      addresses: () => addresses,
      redeem: (_invitation, _label, received) => {
        signal = received;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    });
    const result = starting.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(settled).toBe(false);
    finish();
    expect(await result).toBeInstanceOf(Error);
    await expect(
      exchangeDeviceRequest(request.link!, "inspect")
    ).rejects.toThrow();
  });
  it("exposes startup cleanup ownership while restored enrollment remains active", async () => {
    let finishFirst!: () => void;
    const { paths, service } = await setup(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
      )
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "invitation");
    const firstClose = service.close();
    finishFirst();
    await firstClose;
    writeFileSync(join(paths.runDir, "device-request.sock"), "unsafe");
    let finish!: () => void;
    let signal!: AbortSignal;
    const starting = startDeviceRequestService({
      paths,
      enrolled: async () => false,
      addresses: () => addresses,
      redeem: (_invitation, _label, received) => {
        signal = received;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    });
    const result = starting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5_100);
      const error = await result;
      expect(error).toBeInstanceOf(DeviceRequestStartupUncertainError);
      let settled = false;
      const cleanup = (error as DeviceRequestStartupUncertainError).ownership
        .waitForCleanup()
        .then(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      finish();
      await cleanup;
    } finally {
      vi.useRealTimers();
    }
  });
  it("replays neither encrypted messages nor cancelled requests", async () => {
    const { paths, redeem } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    const parsed = parseDeviceRequestLink(request.link!);
    const encrypted = encryptPersonalDevicePairingMessage(
      { operation: "inspect" },
      { invitationId: parsed.id, token: parsed.token, direction: "request" }
    );
    const send = () =>
      fetch(parsed.url, { method: "POST", body: JSON.stringify(encrypted) });
    const first = await send();
    expect(first.status).toBe(200);
    await first.body?.cancel();
    const replay = await send();
    expect(replay.status).toBe(400);
    await replay.body?.cancel();
    await deviceRequestCommand(paths, "cancel");
    await expect(
      exchangeDeviceRequest(request.link!, "accept", "invitation")
    ).rejects.toThrow();
    expect(redeem).not.toHaveBeenCalled();
  });
  it("restores a waiting link after supervisor restart", async () => {
    const { paths, service, redeem } = await setup();
    const before = await deviceRequestCommand(
      paths,
      "create",
      "Second Electron"
    );
    await service.close();
    const restarted = await startDeviceRequestService({
      paths,
      redeem,
      enrolled: async () => false,
      addresses: () => addresses
    });
    cleanups.push(() => restarted.close());
    expect(await deviceRequestCommand(paths, "create")).toEqual(before);
    expect(await exchangeDeviceRequest(before.link!, "inspect")).toMatchObject({
      label: "Second Electron"
    });
  });
  it("preserves redacted completion after a supervisor restart", async () => {
    const { paths, service, redeem, enrolled } = await setup();
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "connected"
      })
    );
    await service.close();
    const restarted = await startDeviceRequestService({
      paths,
      redeem,
      enrolled,
      addresses: () => addresses
    });
    cleanups.push(() => restarted.close());
    expect(await deviceRequestCommand(paths, "status")).toMatchObject({
      state: "connected"
    });
    expect(await deviceRequestCommand(paths, "status")).not.toHaveProperty(
      "link"
    );
    expect(redeem).toHaveBeenCalledOnce();
  });
  it("reuses one request for concurrent local callers and refuses enrolled installations", async () => {
    const { paths, enrolled } = await setup();
    const [a, b] = await Promise.all([
      deviceRequestCommand(paths, "create"),
      deviceRequestCommand(paths, "create")
    ]);
    expect(a.link).toEqual(b.link);
    enrolled.mockResolvedValue(true);
    await expect(deviceRequestCommand(paths, "create")).rejects.toThrow(
      "already belongs"
    );
  });
  it("does not advertise success or leak transport errors when reconciliation fails", async () => {
    const { paths } = await setup(
      vi.fn(async () => {
        throw new Error("secret-invitation-token");
      })
    );
    const request = await deviceRequestCommand(paths, "create");
    await exchangeDeviceRequest(request.link!, "accept", "private-invitation");
    await vi.waitFor(async () =>
      expect(await deviceRequestCommand(paths, "status")).toMatchObject({
        state: "failed"
      })
    );
    expect(
      JSON.stringify(await deviceRequestCommand(paths, "status"))
    ).not.toContain("secret");
  });
});
describe("local listener startup", () => {
  it("reports bind failure without retaining unacquired listener", async () => {
    const home = mkdtempSync("/tmp/koed-request-");
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const original = Server.prototype.listen;
    const spy = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementation(function (this: Server, ...args: unknown[]) {
        if (typeof args[0] === "string") {
          queueMicrotask(() => this.emit("error", new Error("bind failure")));
          return this;
        }
        return Reflect.apply(original, this, args) as Server;
      } as typeof Server.prototype.listen);
    try {
      await expect(
        startDeviceRequestService({
          paths,
          enrolled: async () => false,
          redeem: async () => {}
        })
      ).rejects.toThrow("bind failure");
    } finally {
      spy.mockRestore();
    }
    const service = await startDeviceRequestService({
      paths,
      enrolled: async () => false,
      redeem: async () => {}
    });
    await service.close();
  });
});
describe("device request interface selection", () => {
  it("prefers an explicit host over automatic selection on a dual-interface device", () => {
    // "10." sorts before "100." lexicographically, so automatic selection
    // would otherwise pick the LAN address even when only Tailscale is
    // reachable from the Authority device.
    expect(
      resolveDeviceRequestHost("100.90.1.2", ["10.0.0.5", "100.90.1.2"])
    ).toBe("100.90.1.2");
  });
  it("falls back to automatic selection when no host is configured", () => {
    expect(
      resolveDeviceRequestHost(undefined, ["100.90.1.2", "10.0.0.5"])
    ).toBe("10.0.0.5");
  });
  it("rejects a configured host that is not a private IPv4 address", () => {
    expect(() => resolveDeviceRequestHost("8.8.8.8", ["10.0.0.5"])).toThrow(
      "private IPv4"
    );
  });
  it("wires an explicit host through the running service into the request link", async () => {
    const home = mkdtempSync("/tmp/koed-request-");
    const paths = resolveKoedServerPaths({ KOED_HOME: home });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    if (!addresses.length) return;
    const pinned = addresses[0]!;
    const service = await startDeviceRequestService({
      paths,
      redeem: vi.fn(async () => {}),
      enrolled: vi.fn(async () => false),
      addresses: () => addresses,
      host: pinned
    });
    cleanups.push(() => service.close());
    const request = await deviceRequestCommand(paths, "create", "Studio");
    expect(new URL(request.link!).hostname).toBe(pinned);
  });
});
