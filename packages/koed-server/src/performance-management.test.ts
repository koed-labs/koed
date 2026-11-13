import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPerformanceManagement,
  createDesktopPerformanceRpcHandler
} from "./performance-management.js";
import { resolveKoedServerPaths } from "./paths.js";
import { resolveKoedServerConfig } from "./config.js";
import * as lifecycle from "./runtime-lifecycle.js";
import { applyResourceProfile } from "./resource-profile.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  mkdirSync("scratch", { recursive: true });
  const root = mkdtempSync(resolve("scratch", "performance-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  const environment: NodeJS.ProcessEnv = {
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  };
  mkdirSync(paths.configDir, { recursive: true });
  const manager = createPerformanceManagement({
    paths,
    environment: () => environment,
    cpuCount: 12
  });
  return { root, paths, environment, manager };
}
describe("Desktop performance preferences", () => {
  it("saves atomically, preserves unrelated configuration, and reaches the startup environment", async () => {
    const f = fixture();
    writeFileSync(
      f.paths.serverConfigPath,
      JSON.stringify({
        hardwareAcceleration: "cpu",
        operatorExtension: { retained: true }
      })
    );
    const current = await f.manager.inspect();
    expect(current.effective).toEqual({
      backgroundNice: 10,
      embeddingThreads: 6,
      transcriptPollMs: 1000
    });
    const next = await f.manager.save({
      profile: "low",
      overrides: {
        backgroundNice: 8,
        embeddingThreads: 4,
        transcriptPollMs: 5000
      },
      expectedRevision: current.revision
    });
    expect(next.effective).toEqual({
      backgroundNice: 8,
      embeddingThreads: 4,
      transcriptPollMs: 5000
    });
    expect(
      JSON.parse(readFileSync(f.paths.serverConfigPath, "utf8"))
    ).toMatchObject({
      hardwareAcceleration: "cpu",
      operatorExtension: { retained: true }
    });
    const config = resolveKoedServerConfig(f.paths, {});
    expect(
      applyResourceProfile({}, config.resourceProfile, {
        overrides: config.resourceOverrides,
        cpuCount: 12
      })
    ).toEqual({
      KOED_BACKGROUND_NICE: "8",
      EMBEDDING_LLAMA_N_THREADS: "4",
      MEMORY_CODEX_TRANSCRIPT_POLL_MS: "5000"
    });
    await expect(
      f.manager.save({
        profile: "full",
        overrides: {},
        expectedRevision: current.revision
      })
    ).rejects.toThrow("changed");
  });
  it("resolves explicit process and env-file values ahead of saved overrides and profiles", async () => {
    const f = fixture();
    writeFileSync(
      resolve(f.root, ".env"),
      "KOED_RESOURCE_PROFILE=low\nLLAMA_N_THREADS=3\nMEMORY_CODEX_TRANSCRIPT_POLL_MS=1500\n"
    );
    writeFileSync(
      f.paths.serverConfigPath,
      JSON.stringify({
        resourceProfile: "full",
        resourceOverrides: { embeddingThreads: 8, backgroundNice: 15 }
      })
    );
    f.environment.KOED_BACKGROUND_NICE = "5";
    const snapshot = await f.manager.inspect();
    expect(snapshot.profileManaged).toBe(true);
    expect(snapshot.preference.profile).toBe("low");
    expect(snapshot.effective).toEqual({
      backgroundNice: 5,
      embeddingThreads: 3,
      transcriptPollMs: 1500
    });
    expect(Object.keys(snapshot.managed)).toHaveLength(3);
    await expect(
      f.manager.save({
        profile: "balanced",
        overrides: {},
        expectedRevision: snapshot.revision
      })
    ).rejects.toThrow("environment controls");
    await expect(
      f.manager.save({
        profile: "low",
        overrides: { embeddingThreads: 9 },
        expectedRevision: snapshot.revision
      })
    ).rejects.toThrow("environment");
    const result = await f.manager.save({
      profile: "low",
      overrides: {},
      expectedRevision: snapshot.revision
    });
    expect(result.effective.embeddingThreads).toBe(3);
    expect(
      (
        JSON.parse(readFileSync(f.paths.serverConfigPath, "utf8")) as {
          resourceProfile: string;
        }
      ).resourceProfile
    ).toBe("full");
  });
  it("fails closed for malformed settings, invalid values, external runtimes and foreign owners", async () => {
    const f = fixture();
    let s = await f.manager.inspect();
    await expect(
      f.manager.save({
        profile: "full",
        overrides: { embeddingThreads: 13 },
        expectedRevision: s.revision
      })
    ).rejects.toThrow("logical CPUs");
    await expect(
      f.manager.save({
        profile: "full",
        overrides: { backgroundNice: -1 },
        expectedRevision: s.revision
      })
    ).rejects.toThrow();
    f.environment.KOED_RUNTIME_MODE = "external";
    s = await f.manager.inspect();
    await expect(
      f.manager.save({
        profile: "full",
        overrides: {},
        expectedRevision: s.revision
      })
    ).rejects.toThrow("external");
    delete f.environment.KOED_RUNTIME_MODE;
    vi.spyOn(lifecycle, "observeRuntimeLifecycle").mockReturnValue({
      state: "running",
      epoch: "foreign",
      message: "",
      owner: { kind: "source", installationId: "another" } as never
    });
    expect((await f.manager.inspect()).readOnlyReason).toMatch(/Another/);
    writeFileSync(f.paths.serverConfigPath, "{broken");
    await expect(f.manager.inspect()).rejects.toThrow();
    expect(readFileSync(f.paths.serverConfigPath, "utf8")).toBe("{broken");
  });
  it("reads invalid environment values with the components' fallbacks", async () => {
    const f = fixture();
    f.environment.KOED_BACKGROUND_NICE = "20";
    f.environment.LLAMA_N_THREADS = "-1";
    f.environment.MEMORY_CODEX_TRANSCRIPT_POLL_MS = "1500ms";
    const s = await f.manager.inspect();
    expect(s.effective).toEqual({
      backgroundNice: 10,
      embeddingThreads: 6,
      transcriptPollMs: 1500
    });
    expect(Object.keys(s.invalid)).toEqual([
      "backgroundNice",
      "embeddingThreads"
    ]);
    expect(s.invalid.backgroundNice).toMatch(/KOED_BACKGROUND_NICE/);
    expect(s.managed.transcriptPollMs).toBe("Managed by the environment");
    await expect(
      f.manager.save({
        profile: "low",
        overrides: {},
        expectedRevision: s.revision
      })
    ).resolves.toMatchObject({ preference: { profile: "low" } });
  });
  it("rejects unauthenticated, malformed and duplicate private supervisor requests", async () => {
    const f = fixture();
    const save = vi.spyOn(f.manager, "save");
    const inspect = vi.spyOn(f.manager, "inspect");
    const send = vi.fn();
    const handle = createDesktopPerformanceRpcHandler({
      manager: f.manager,
      nonce: "private",
      send
    });
    const request = {
      type: "koed.desktop.performance.request",
      nonce: "private",
      requestId: "00000000-0000-4000-8000-000000000000",
      action: "inspect"
    };
    expect(handle({ ...request, nonce: "wrong" })).toBe(false);
    expect(handle({ ...request, unexpected: true })).toBe(false);
    expect(handle(request)).toBe(true);
    expect(handle(request)).toBe(true);
    expect(inspect).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  });
});
