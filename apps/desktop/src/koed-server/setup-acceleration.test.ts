import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccelerationSnapshot,
  AccelerationInstallResult
} from "@koed-labs/server";
import type { DesktopSetupSnapshot } from "../types.js";
import { accelerationSnapshot } from "../renderer/v1/acceleration.fixture.js";

const control = vi.hoisted(() => ({
  snapshot: null as AccelerationSnapshot | null,
  running: false,
  runtime: false,
  model: false,
  failCuda: false,
  installGate: null as Promise<void> | null,
  installSignal: null as AbortSignal | null,
  calls: [] as string[]
}));
vi.mock("@koed-labs/server", async (original) => ({
  ...(await original<typeof import("@koed-labs/server")>()),
  observeRuntimeLifecycle: () => ({
    state: control.running ? "running" : "stopped",
    epoch: control.running ? "owned-runtime" : "stopped",
    message: "Fixture"
  }),
  createAccelerationManagement: () => ({
    inspect: async () => ({
      ...control.snapshot!,
      runtimeEpoch: control.running ? "owned-runtime" : "stopped"
    }),
    save: async (choice: {
      preference: "cpu" | "auto";
      expectedRevision: string;
    }) => {
      if (choice.expectedRevision !== control.snapshot!.revision)
        throw new Error("Stale preference write");
      control.calls.push(`save:${choice.preference}`);
      control.snapshot = {
        ...control.snapshot!,
        preference: choice.preference,
        revision: "d".repeat(64),
        configurationRevision: "d".repeat(64)
      };
      return control.snapshot;
    },
    install: async (
      choice: { mode: "core" | "cuda" },
      signal: AbortSignal
    ): Promise<AccelerationInstallResult> => {
      // On Linux the release provider installs the core runtime through this
      // same seam before the model stage; CUDA follows the model stage.
      if (choice.mode === "core") {
        control.runtime = true;
        control.calls.push("core");
        return {
          snapshot: control.snapshot!,
          validation: "inference",
          changed: true
        };
      }
      control.calls.push("cuda");
      control.installSignal = signal;
      await control.installGate;
      signal.throwIfAborted();
      if (!control.model) throw new Error("Model must precede CUDA");
      if (control.failCuda)
        throw new Error("CUDA inference verification failed");
      control.snapshot = {
        ...control.snapshot!,
        revision: "b".repeat(64),
        cuda: {
          ...control.snapshot!.cuda,
          state: "installed",
          validation: "inference"
        }
      };
      return {
        snapshot: control.snapshot,
        validation: "inference",
        changed: true
      };
    },
    runtimeStatus: () => ({
      ok: control.runtime,
      state: control.runtime ? "installed" : "missing"
    })
  })
}));
import { createKoedServerManager } from "./manager.js";

let root: string;
let manager: ReturnType<typeof createKoedServerManager>;
beforeEach(() => {
  Object.assign(control, {
    snapshot: accelerationSnapshot(),
    running: false,
    runtime: false,
    model: false,
    failCuda: false,
    installGate: null,
    installSignal: null,
    calls: []
  });
  mkdirSync("scratch", { recursive: true });
  root = mkdtempSync(resolve("scratch", "setup-acceleration-"));
  manager = createManager();
});
const createManager = () =>
  createKoedServerManager({
    repoRoot: root,
    cliPath: resolve(root, "cli.js"),
    environment: {
      KOED_HOME: root,
      KOED_REPO_ROOT: root,
      KOED_TEAM_COLLABORATION_ENABLED: "false"
    },
    createCliInvocation: (args) => ({
      command: "/node",
      args: ["fixture-cli", ...args],
      env: {}
    }),
    // CUDA acceleration is a Linux path, so exercise Linux release-provider
    // runtime selection regardless of the host running the tests.
    platform: "linux",
    existsSync: () => true,
    execFile: (_command, args, _options, callback) => {
      let value: unknown = { ok: true, state: "installed" };
      if (args[1] === "runtime") {
        if (args.includes("install")) {
          control.runtime = true;
          control.calls.push("core");
        }
        value = {
          ok: control.runtime,
          state: control.runtime ? "installed" : "missing"
        };
      } else if (args[1] === "models") {
        if (args.includes("install")) {
          control.model = true;
          control.calls.push("model");
          control.snapshot!.revision = "c".repeat(64);
        }
        value = {
          ok: control.model,
          state: control.model ? "installed" : "missing"
        };
      } else if (args[1] === "start") {
        control.running = true;
        control.calls.push("start");
        control.snapshot!.embedding = {
          state: "ready",
          backend: control.snapshot!.preference === "auto" ? "cuda" : "cpu",
          fallbackReason: null
        };
      } else if (args[1] === "stop") {
        control.running = false;
      } else if (args[1] === "status") {
        const healthy = { state: "healthy" };
        value = {
          ok: control.running,
          state: control.running ? "healthy" : "stopped",
          runtimeMode: "local-personal",
          dependencyMode: "bundled-local",
          generatedAt: new Date().toISOString(),
          koedHome: root,
          api: {
            state: control.running ? "healthy" : "stopped",
            url: "http://127.0.0.1:4170"
          },
          database: healthy,
          redis: healthy,
          workerQueues: healthy,
          embeddingService: healthy,
          privacyService: healthy,
          localAiRuntime: healthy,
          apiToken: { ...healthy, configured: true },
          mcpServer: healthy,
          captureHook: healthy,
          lcmSummaryService: healthy,
          upstreamBackends: {
            state: "healthy",
            registered: 0,
            validated: 0,
            stale: 0,
            failed: 0,
            notChecked: 0
          },
          lastVerification: { state: "not_configured", checkedAt: null }
        };
      }
      callback(null, JSON.stringify(value), "");
    },
    spawn: () =>
      Object.assign(new EventEmitter(), {
        killed: false,
        kill: () => true
      }) as never,
    openExternal: async () => undefined
  });
afterEach(async () => {
  await manager?.stop();
  rmSync(root, { recursive: true, force: true });
});
const cuda = {
  preference: "auto",
  installCuda: true,
  expectedRevision: "a".repeat(64)
} as const;
function context() {
  const window = new AbortController();
  const updates: DesktopSetupSnapshot[] = [];
  return {
    window,
    updates,
    value: {
      ownerId: "onboarding",
      signal: window.signal,
      emitCollaborationEvent: () => {},
      emitSetupProgress: (state: DesktopSetupSnapshot) => updates.push(state)
    }
  };
}

describe("Desktop acceleration setup integration", () => {
  it("orders core, model and CUDA verification before enabling automatic processing and starting services", async () => {
    const c = context();
    const result = await manager.handlers.setup_run!(
      { operatorConsented: true, acceleration: cuda },
      c.value
    );
    expect(result).toMatchObject({ state: "complete" });
    expect(control.calls).toEqual([
      "core",
      "model",
      "cuda",
      "save:auto",
      "start"
    ]);
    expect(c.updates.at(-1)?.stages.map(({ id }) => id)).toEqual([
      "package",
      "runtime",
      "model",
      "acceleration",
      "services",
      "integration",
      "verification"
    ]);
    expect(
      (await manager.acceleration.inspect()).snapshot?.embedding.backend
    ).toBe("cuda");
  });
  it("installs the core runtime on fresh Linux when the Operator manages acceleration", async () => {
    control.snapshot = {
      ...control.snapshot!,
      source: "environment",
      readOnlyReason: "The Operator environment controls local acceleration.",
      runtimeReadOnlyReason: null
    };
    const result = await manager.handlers.setup_run!(
      { operatorConsented: true },
      context().value
    );
    expect(result).toMatchObject({ state: "complete" });
    expect(control.calls).toEqual(["core", "model", "start"]);
  });
  it("refuses to continue an interrupted CUDA setup without a fresh choice after restart", async () => {
    mkdirSync(resolve(root, "cache"), { recursive: true });
    writeFileSync(
      resolve(root, "cache", "desktop-setup-operation.json"),
      JSON.stringify({
        id: "d6abf730-0f02-4adc-a7e6-4ddf98f30905",
        sequence: 2,
        state: "running",
        reviewProcessing: true
      })
    );
    await manager.stop();
    manager = createManager();
    expect(await manager.handlers.setup_inspect!()).toMatchObject({
      state: "failed",
      reviewProcessing: true
    });
    await expect(
      manager.handlers.setup_run!({ operatorConsented: true }, context().value)
    ).rejects.toThrow("Review your processing choice");
    expect(control.calls).toEqual([]);
    const result = await manager.handlers.setup_run!(
      { operatorConsented: true, acceleration: cuda },
      context().value
    );
    expect(result).toMatchObject({ state: "complete" });
    expect(control.calls).toContain("cuda");
  });
  it("retains core and model work after CUDA failure and resumes through explicit CPU recovery", async () => {
    control.failCuda = true;
    const c = context();
    expect(
      await manager.handlers.setup_run!(
        { operatorConsented: true, acceleration: cuda },
        c.value
      )
    ).toMatchObject({ state: "failed", activeStage: "acceleration" });
    expect(await manager.handlers.setup_inspect!()).toMatchObject({
      state: "failed",
      activeStage: "acceleration"
    });
    expect(control.calls).not.toContain("save:auto");
    const fresh = await manager.acceleration.inspect(true);
    const result = await manager.handlers.setup_run!(
      {
        operatorConsented: true,
        acceleration: {
          preference: "cpu",
          installCuda: false,
          expectedRevision: fresh.snapshot!.revision
        }
      },
      c.value
    );
    expect(result).toMatchObject({ state: "complete" });
    expect(control.calls).toEqual([
      "core",
      "model",
      "cuda",
      "save:cpu",
      "start"
    ]);
  });
  it("keeps a run owned by main after its original window disconnects", async () => {
    let resume!: () => void;
    control.installGate = new Promise<void>((resolveGate) => {
      resume = resolveGate;
    });
    const c = context();
    const run = manager.handlers.setup_run!(
      { operatorConsented: true, acceleration: cuda },
      c.value
    );
    await vi.waitFor(() => expect(control.calls).toContain("cuda"));
    c.window.abort();
    expect(control.installSignal?.aborted).toBe(false);
    expect(await manager.handlers.setup_inspect!()).toMatchObject({
      state: "running",
      activeStage: "acceleration"
    });
    resume();
    expect(await run).toMatchObject({ state: "complete" });
  });
});
