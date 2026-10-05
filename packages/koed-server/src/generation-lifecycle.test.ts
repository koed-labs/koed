import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeIdentity } from "./component-contract.js";

const fixtureRuntime = vi.hoisted(() => ({
  value: undefined as RuntimeIdentity | undefined
}));
const fixtureKeys = vi.hoisted(() => ({ value: new Map<string, string>() }));
const pointerFailure = vi.hoisted(() => ({
  path: undefined as string | undefined
}));
vi.mock("./component-runtime-identity.js", () => ({
  discoverActualRuntimeIdentity: () => {
    if (!fixtureRuntime.value) throw new Error("fixture runtime missing");
    return fixtureRuntime.value;
  }
}));
vi.mock("./component-trust-roots.js", () => ({
  productionComponentTrustRoots: fixtureKeys.value
}));
vi.mock("./generation-lifecycle-filesystem.js", async () => {
  const { renameSync } =
    await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    renameAtomically: (source: string, destination: string) => {
      if (destination === pointerFailure.path)
        throw Object.assign(new Error("simulated interrupted pointer swap"), {
          code: "EIO"
        });
      renameSync(source, destination);
    }
  };
});

import { signedComponentFixture } from "./component-test-fixtures.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  pinGenerationForStart,
  activateGeneration,
  cleanupGenerations,
  readCurrentGeneration
} from "./generation-lifecycle.js";
import * as componentStore from "./component-store.js";
import * as supervisorLock from "./supervisor-lock.js";
import { stageComponent, stageGeneration } from "./component-store.js";

const temporaryRoots: string[] = [];
const temporaryMetadata: string[] = [];
const owner = { kind: "standalone" as const, installationId: "lifecycle-test" };
const pathsForTest = () => {
  const home = mkdtempSync(
    resolve(process.cwd(), ".koed-generation-lifecycle-")
  );
  temporaryRoots.push(home);
  return resolveKoedServerPaths({ KOED_HOME: home, KOED_REPO_ROOT: home });
};
const metadataFile = (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  bytes: Buffer
): string => {
  const path = resolve(paths.koedHome, `metadata-${Math.random()}.json`);
  mkdirSync(paths.koedHome, { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  temporaryMetadata.push(path);
  return path;
};
const stage = async (
  paths: ReturnType<typeof resolveKoedServerPaths>,
  version: string
) => {
  const fixture = await signedComponentFixture({ productVersion: version });
  temporaryRoots.push(fixture.root);
  fixtureRuntime.value = fixture.input.runtime;
  for (const [key, value] of fixture.input.trustedKeys)
    fixtureKeys.value.set(key, value);
  const base = await stageComponent(
    paths,
    {
      kind: "offline",
      archivePath: fixture.input.archivePath,
      manifestPath: metadataFile(paths, fixture.input.manifestBytes),
      signaturePath: metadataFile(
        paths,
        Buffer.from(JSON.stringify(fixture.input.signature))
      )
    },
    {
      expectedComponent: "base",
      expectedVersion: version,
      target: fixture.input.target,
      runtime: fixture.input.runtime
    }
  );
  return stageGeneration(paths, { base, owner });
};

afterEach(() => {
  for (const path of temporaryRoots.splice(0))
    rmSync(path, { recursive: true, force: true });
  for (const path of temporaryMetadata.splice(0)) rmSync(path, { force: true });
  pointerFailure.path = undefined;
  vi.restoreAllMocks();
});

describe("generation lifecycle", () => {
  it("pins selected generation for process lifetime and blocks activation/cleanup", async () => {
    const paths = pathsForTest();
    const current = await stage(paths, "0.9.0");
    const next = await stage(paths, "0.9.1");
    await activateGeneration(paths, current.id, owner);
    let signalReached!: () => void;
    let releaseBarrier!: () => void;
    const reachedBarrier = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const originalRead = componentStore.readStagedGeneration;
    vi.spyOn(componentStore, "readStagedGeneration").mockImplementation(
      async (storePaths, id) => {
        const generation = await originalRead(storePaths, id);
        signalReached();
        await barrier;
        return generation;
      }
    );
    const pinPromise = pinGenerationForStart(paths, owner);
    await reachedBarrier;
    await expect(activateGeneration(paths, next.id, owner)).rejects.toThrow(
      /running|pinned|lock/i
    );
    releaseBarrier();
    const pin = await pinPromise;
    expect(pin.generation.id).toBe(current.id);
    const child = spawnSync(process.execPath, [
      "-e",
      `const fs=require('node:fs'); try { fs.mkdirSync(${JSON.stringify(resolve(paths.runDir, "generation-lifecycle.lock"))}); process.exit(2); } catch (error) { process.exit(error.code === 'EEXIST' ? 0 : 3); }`
    ]);
    expect(child.status).toBe(0);
    await expect(cleanupGenerations(paths, 1, owner)).rejects.toThrow(
      /running|pinned|locked/i
    );
    expect((await readCurrentGeneration(paths)).id).toBe(current.id);
    expect(
      readFileSync(
        resolve(paths.generationsDir, current.id, "generation.json"),
        "utf8"
      )
    ).toBeTruthy();
    await pin.release();
    expect((await activateGeneration(paths, next.id, owner)).id).toBe(next.id);
  });

  it("rejects owner mismatch and preserves model and User data during cleanup", async () => {
    const paths = pathsForTest();
    const current = await stage(paths, "0.9.0");
    const stateFile = resolve(paths.dataDir, "user-state.json");
    const modelFile = resolve(paths.modelsDir, "embedding/model.gguf");
    mkdirSync(resolve(stateFile, ".."), { recursive: true });
    mkdirSync(resolve(modelFile, ".."), { recursive: true });
    writeFileSync(stateFile, "preserve-user-state");
    writeFileSync(modelFile, "preserve-model");
    await expect(
      activateGeneration(paths, current.id, {
        ...owner,
        installationId: "other"
      })
    ).rejects.toThrow(/owner/i);
    await cleanupGenerations(paths, 1, owner);
    expect(readFileSync(stateFile, "utf8")).toBe("preserve-user-state");
    expect(readFileSync(modelFile, "utf8")).toBe("preserve-model");
  });

  it("reclaims pin from conclusively dead PID before activation", async () => {
    const paths = pathsForTest();
    const generation = await stage(paths, "0.9.0");
    const stalePinPath = paths.generationStatePath!;
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      stalePinPath,
      JSON.stringify({
        schemaVersion: 1,
        generationId: generation.id,
        pid: 2147483647,
        processIdentity: "dead-process-identity",
        startedAt: "2026-10-05T00:00:00.000Z",
        owner,
        pinToken: "a".repeat(64)
      })
    );
    await activateGeneration(paths, generation.id, owner);
    expect(existsSync(stalePinPath)).toBe(false);
  });

  it("fails closed when stale-pin liveness cannot be confirmed", async () => {
    const paths = pathsForTest();
    const generation = await stage(paths, "0.9.0");
    const stalePinPath = paths.generationStatePath!;
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      stalePinPath,
      JSON.stringify({
        schemaVersion: 1,
        generationId: generation.id,
        pid: process.pid,
        processIdentity: "unreadable-process-identity",
        startedAt: "2026-10-05T00:00:00.000Z",
        owner,
        pinToken: "b".repeat(64)
      })
    );
    const actualIdentity = supervisorLock.resolveProcessIdentity;
    let lookups = 0;
    vi.spyOn(supervisorLock, "resolveProcessIdentity").mockImplementation(
      (pid) => {
        lookups += 1;
        return lookups === 1 ? actualIdentity(pid) : null;
      }
    );
    await expect(
      activateGeneration(paths, generation.id, owner)
    ).rejects.toThrow(/running|pinned/i);
    expect(existsSync(stalePinPath)).toBe(true);
  });

  it("releases only pin state carrying matching token", async () => {
    const paths = pathsForTest();
    const generation = await stage(paths, "0.9.0");
    await activateGeneration(paths, generation.id, owner);
    const pin = await pinGenerationForStart(paths, owner);
    const pinPath = paths.generationStatePath!;
    const state = JSON.parse(readFileSync(pinPath, "utf8")) as Record<
      string,
      unknown
    >;
    state.pinToken = "c".repeat(64);
    writeFileSync(pinPath, JSON.stringify(state));
    await pin.release();
    expect(existsSync(pinPath)).toBe(true);
  });

  it("rejects Desktop activation for a standalone-owned generation", async () => {
    const paths = pathsForTest();
    const generation = await stage(paths, "0.9.0");
    await expect(
      activateGeneration(paths, generation.id, {
        kind: "desktop",
        installationId: owner.installationId
      })
    ).rejects.toThrow("runtime owner mismatch");
  });

  it("retains active and newest verified generations without touching User state or models", async () => {
    const paths = pathsForTest();
    const active = await stage(paths, "0.9.0");
    const obsolete = await stage(paths, "0.9.1");
    const newest = await stage(paths, "0.9.2");
    await activateGeneration(paths, active.id, owner);
    const removed = await cleanupGenerations(paths, 1, owner);
    expect(removed).toContain(obsolete.id);
    expect(removed).not.toContain(active.id);
    expect(removed).not.toContain(newest.id);
    expect((await readCurrentGeneration(paths)).id).toBe(active.id);
  });

  it("preserves current pointer when atomic rename is interrupted", async () => {
    const paths = pathsForTest();
    const current = await stage(paths, "0.9.0");
    const next = await stage(paths, "0.9.1");
    await activateGeneration(paths, current.id, owner);
    const pointer = resolve(paths.componentsDir, "current.json");
    const before = readFileSync(pointer, "utf8");
    pointerFailure.path = pointer;
    await expect(activateGeneration(paths, next.id, owner)).rejects.toThrow(
      "simulated interrupted pointer swap"
    );
    expect(readFileSync(pointer, "utf8")).toBe(before);
    expect((await readCurrentGeneration(paths)).id).toBe(current.id);
  });
});
