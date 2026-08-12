import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRunLease,
  readRunLeaseOwner,
  type RunLeaseSystem
} from "./run-lease.js";

const identity = {
  hostname: "fixture-host",
  machineId: "fixture-machine",
  bootId: "fixture-boot",
  pid: 101,
  processStartTicks: "1001"
};

const system = (overrides: Partial<RunLeaseSystem> = {}): RunLeaseSystem => ({
  currentOwner: async () => identity,
  processStartTicks: async (pid) => (pid === identity.pid ? "1001" : null),
  ...overrides
});

describe("Experience Replay cross-process run lease", () => {
  it("excludes another owner and releases only its own lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-run-lease-"));
    const first = await acquireRunLease(root, { system: system() });
    await expect(acquireRunLease(root, { system: system() })).rejects.toThrow(
      "already leased"
    );
    expect((await readRunLeaseOwner(root)).ownerToken).toBe(
      first.owner.ownerToken
    );
    await first.release();
    await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await first.release();
  });

  it("reclaims only after proving the exact recorded process is stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-run-lease-"));
    const original = await acquireRunLease(root, { system: system() });
    const replacement = await acquireRunLease(root, {
      system: system({ processStartTicks: async () => "different-start" })
    });
    expect(replacement.owner.ownerToken).not.toBe(original.owner.ownerToken);
    await expect(original.release()).rejects.toThrow("another process");
    await replacement.release();
  });

  it("fails closed for another machine and malformed owner records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-run-lease-"));
    const first = await acquireRunLease(root, { system: system() });
    await expect(
      acquireRunLease(root, {
        system: system({
          currentOwner: async () => ({
            ...identity,
            machineId: "different-machine",
            pid: 202,
            processStartTicks: "2002"
          })
        })
      })
    ).rejects.toThrow("already leased");
    await first.release();

    await writeFile(path.join(root, ".experience-replay.lease"), "not-json\n");
    await expect(acquireRunLease(root, { system: system() })).rejects.toThrow(
      "invalid JSON"
    );
  });

  it("fails closed when stale-owner recovery was interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-run-lease-"));
    await writeFile(
      path.join(root, ".experience-replay.lease.reclaim"),
      "abandoned-reclaimer\n"
    );
    await expect(acquireRunLease(root, { system: system() })).rejects.toThrow(
      "recovery is already in progress"
    );
  });
});
