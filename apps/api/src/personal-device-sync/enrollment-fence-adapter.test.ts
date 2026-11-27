import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rotateDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed-labs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnrollmentFence } from "./enrollment-fence.js";
import { createEnrollmentFenceAdapter } from "./enrollment-fence-adapter.js";
import { resolveOwnerBinding } from "./owner-binding.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const homes: string[] = [];

async function setup(fence = new EnrollmentFence()) {
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  mkdirSync(scratch, { recursive: true });
  const koedHome = mkdtempSync(resolve(scratch, "fence-adapter-"));
  homes.push(koedHome);
  const credential = storeDesktopLocalCredential(koedHome, {
    ownerUserId: userId,
    operationFamilies: ["personal_collaboration_write"]
  });
  let enabled = true;
  const options = {
    koedHome,
    deploymentProfile: "local_personal",
    resolveActiveLocalUser: async (id: string) => (enabled ? { id } : null),
    reportOperationalFailure: (_category: "custody" | "user_lookup") => {}
  };
  const binding = (await resolveOwnerBinding(options))!;
  const adapter = createEnrollmentFenceAdapter(fence, binding, options);
  return {
    fence,
    koedHome,
    credential,
    options,
    binding,
    adapter,
    disable: () => {
      enabled = false;
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("endpoint enrollment fence adapter", () => {
  it.each(["rotation", "disable"])(
    "drains admitted work after %s but rejects new work",
    async (change) => {
      const { adapter, fence, binding, koedHome, disable } = await setup();
      const epochId = await adapter.createEpoch();
      const ids = { instanceId: adapter.instanceId, epochId };
      const operationId = await adapter.register(ids);
      const release = fence.enter({
        ...ids,
        operationId,
        owner: binding.owner
      });
      if (change === "rotation") rotateDesktopLocalCredential(koedHome);
      else disable();
      await expect(adapter.createEpoch()).rejects.toThrow();
      await expect(adapter.register(ids)).rejects.toThrow();
      expect(await adapter.fenceOperation({ ...ids, operationId })).toBe(
        "pending"
      );
      expect(await adapter.fenceEpoch(ids)).toBe("pending");
      release();
      expect(await adapter.fenceOperation({ ...ids, operationId })).toBe(
        "drained"
      );
      expect(await adapter.fenceEpoch(ids)).toBe("drained");
    }
  );

  it("rejects epochs created by another endpoint even for the same owner", async () => {
    const { adapter, fence, binding, options } = await setup();
    const other = createEnrollmentFenceAdapter(fence, binding, options);
    const ids = {
      instanceId: fence.instanceId,
      epochId: await other.createEpoch()
    };
    const operationId = await other.register(ids);
    await expect(
      other.fenceOperation({
        ...ids,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      })
    ).rejects.toThrow();
    await expect(adapter.register(ids)).rejects.toThrow();
    await expect(adapter.fenceEpoch(ids)).rejects.toThrow();
    await expect(
      adapter.fenceOperation({ ...ids, operationId })
    ).rejects.toThrow();
  });

  it("retains its original binding if the supplied object is changed", async () => {
    const { fence, binding, options } = await setup();
    const mutable = { ...binding };
    const adapter = createEnrollmentFenceAdapter(fence, mutable, options);
    const ids = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    mutable.owner = "desktop:replacement";
    mutable.credentialKeyId = "replacement";
    const operationId = await adapter.register(ids);
    const release = fence.enter({ ...ids, operationId, owner: binding.owner });
    expect(await adapter.fenceEpoch(ids)).toBe("pending");
    release();
    expect(await adapter.fenceEpoch(ids)).toBe("drained");
  });

  it("rejects mismatched instances and evicted epochs instead of reporting drained", async () => {
    const { adapter, fence, binding } = await setup(
      new EnrollmentFence({ maxEpochs: 1 })
    );
    const ids = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    await expect(
      adapter.fenceEpoch({
        ...ids,
        instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      })
    ).rejects.toThrow();
    expect(await adapter.fenceEpoch(ids)).toBe("drained");
    fence.createEpoch(binding.owner);
    await expect(adapter.fenceEpoch(ids)).rejects.toThrow();
  });

  it("enforces a lifetime quota even when the primitive evicts drained epochs", async () => {
    const { fence, binding, options } = await setup(
      new EnrollmentFence({ maxEpochs: 1 })
    );
    const adapter = createEnrollmentFenceAdapter(fence, binding, options, 2);
    const first = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    expect(await adapter.fenceEpoch(first)).toBe("drained");
    const second = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    expect(await adapter.fenceEpoch(second)).toBe("drained");
    await expect(adapter.fenceEpoch(first)).rejects.toThrow();
    await expect(adapter.createEpoch()).rejects.toThrow();
    expect(await adapter.fenceEpoch(second)).toBe("drained");
  });

  it("enforces its quota across concurrent creation requests", async () => {
    const { fence, binding, options } = await setup();
    const adapter = createEnrollmentFenceAdapter(fence, binding, options, 1);
    const results = await Promise.allSettled([
      adapter.createEpoch(),
      adapter.createEpoch()
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(() =>
      createEnrollmentFenceAdapter(fence, binding, options, 101)
    ).toThrow();
  });

  it("closes admission and waits for a deferred creation before drain can be assessed", async () => {
    const { fence, binding, options } = await setup();
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const adapter = createEnrollmentFenceAdapter(fence, binding, {
      ...options,
      resolveActiveLocalUser: async (id) => {
        entered();
        await gate;
        return { id };
      }
    });
    const createEpoch = vi.spyOn(fence, "createEpoch");
    const creation = adapter.createEpoch();
    const rejectedCreation = expect(creation).rejects.toThrow();
    await started;
    let closed = false;
    const closing = adapter.closeAdmission().then(() => {
      closed = true;
    });
    await expect(adapter.createEpoch()).rejects.toThrow();
    expect(closed).toBe(false);
    resume();
    await rejectedCreation;
    await closing;
    expect(closed).toBe(true);
    expect(createEpoch).not.toHaveBeenCalled();
  });

  it("waits for creation when eligibility reentrantly closes admission", async () => {
    const { fence, binding, options } = await setup();
    let resume!: () => void;
    let started!: () => void;
    let closing!: Promise<void>;
    let closed = false;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = createEnrollmentFenceAdapter(fence, binding, {
      ...options,
      resolveActiveLocalUser: async (id) => {
        closing = adapter.closeAdmission().then(() => {
          closed = true;
        });
        started();
        await gate;
        return { id };
      }
    });
    const createEpoch = vi.spyOn(fence, "createEpoch");
    const creation = adapter.createEpoch();
    const rejectedCreation = expect(creation).rejects.toThrow();
    await entered;
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(adapter.createEpoch()).rejects.toThrow();
    resume();
    await rejectedCreation;
    await closing;
    expect(createEpoch).not.toHaveBeenCalled();
  });

  it("does not register after admission closes during eligibility recheck", async () => {
    const { fence, binding, options } = await setup();
    let resume!: () => void;
    let entered!: () => void;
    let stalled = false;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = createEnrollmentFenceAdapter(fence, binding, {
      ...options,
      resolveActiveLocalUser: async (id) => {
        if (stalled) {
          entered();
          await gate;
        }
        return { id };
      }
    });
    const ids = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    const register = vi.spyOn(fence, "register");
    stalled = true;
    const registration = adapter.register(ids);
    const rejectedRegistration = expect(registration).rejects.toThrow();
    await started;
    const closing = adapter.closeAdmission();
    resume();
    await rejectedRegistration;
    await closing;
    expect(register).not.toHaveBeenCalled();
    expect(await adapter.fenceEpoch(ids)).toBe("drained");
  });

  it("bounds stalled create and register admissions before user lookup", async () => {
    const { fence, binding, options } = await setup();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let lookups = 0;
    let stall = false;
    const adapter = createEnrollmentFenceAdapter(fence, binding, {
      ...options,
      resolveActiveLocalUser: async (id) => {
        if (stall) {
          lookups++;
          await gate;
        }
        return { id };
      }
    });
    const ids = {
      instanceId: fence.instanceId,
      epochId: await adapter.createEpoch()
    };
    stall = true;
    const pending = Array.from({ length: 16 }, (_, i) =>
      i % 2 ? adapter.register(ids) : adapter.createEpoch()
    );
    const rejected = adapter.register(ids);
    await expect(rejected).rejects.toThrow();
    expect(lookups).toBe(16);
    resume();
    expect(
      (await Promise.allSettled(pending)).every(
        (result) => result.status === "fulfilled"
      )
    ).toBe(true);
    await expect(adapter.register(ids)).resolves.toBeTypeOf("string");
  });

  it("sanitizes eligibility and primitive errors without leaking secrets", async () => {
    const { adapter, fence, credential, options, binding } = await setup();
    const failing = createEnrollmentFenceAdapter(fence, binding, {
      ...options,
      resolveActiveLocalUser: async () => {
        throw new Error(credential.authorization);
      },
      reportOperationalFailure: () => {
        throw new Error(credential.authorization);
      }
    });
    const error = await failing.createEpoch().catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(credential.authorization);
    vi.spyOn(fence, "createEpoch").mockImplementation(() => {
      throw new Error(credential.authorization);
    });
    const primitiveError = await adapter
      .createEpoch()
      .catch((cause: Error) => cause);
    expect(primitiveError).toBeInstanceOf(Error);
    expect(String(primitiveError)).not.toContain(credential.authorization);
  });
});
