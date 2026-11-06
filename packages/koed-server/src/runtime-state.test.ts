import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import {
  isRuntimeGenerationState,
  removeOwnedRuntimeState,
  writeRuntimeState
} from "./runtime-state.js";

const validState = () => ({
  schemaVersion: 1,
  generationId: "a".repeat(64),
  pid: 1234,
  processIdentity: "host:linux:boot-id:process-start",
  startedAt: "2026-10-05T00:00:00.000Z",
  owner: { kind: "desktop", installationId: "koed-desktop" },
  pinToken: "b".repeat(64)
});

describe("runtime generation state", () => {
  it("accepts exact generation pin state", () => {
    expect(isRuntimeGenerationState(validState())).toBe(true);
  });

  it.each([
    { ...validState(), unknown: true },
    { ...validState(), generationId: "not-a-digest" },
    { ...validState(), pid: 0 },
    { ...validState(), processIdentity: "" },
    { ...validState(), startedAt: "invalid" },
    { ...validState(), owner: { kind: "public", installationId: "spoof" } },
    { ...validState(), pinToken: "short" }
  ])("rejects malformed or unbound pin state %#", (state) => {
    expect(isRuntimeGenerationState(state)).toBe(false);
  });
});

it("locks the same runtime record for publication, final ownership check and removal", () => {
  const home = mkdtempSync(join(tmpdir(), "koed-runtime-record-"));
  const path = join(home, "koed-server.json");
  const previous = {
    pid: 41,
    startedAt: "2026-11-05T14:00:00.000Z",
    repoRoot: home,
    apiUrl: "http://localhost:3300",
    services: []
  };
  const next = { ...previous, pid: 42, startedAt: "2026-11-05T15:00:00.000Z" };
  const lock = vi.spyOn(lockfile, "lockSync");
  try {
    writeRuntimeState(path, previous);
    expect(lock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ realpath: false })
    );
    expect(
      removeOwnedRuntimeState(
        path,
        previous,
        (file, encoding) => {
          expect(lockfile.checkSync(path, { realpath: false })).toBe(true);
          return readFileSync(file, encoding);
        },
        (file, options) => {
          // A concurrent start cannot publish between the final read and unlink.
          expect(() => lockfile.lockSync(path, { realpath: false })).toThrow(
            expect.objectContaining({ code: "ELOCKED" })
          );
          rmSync(file, options);
        }
      )
    ).toBe(true);
    writeRuntimeState(path, next);
    expect(removeOwnedRuntimeState(path, previous)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
  } finally {
    lock.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
