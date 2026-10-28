import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { createKoedServerManager } from "./manager.js";
import type { HqOnboardingStatus } from "../ipc/hq-onboarding-protocol.js";
import {
  ensureHqOnboardingState,
  hqOnboardingStatePath,
  readHqOnboardingState
} from "./hq-onboarding-state.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const readyStatus = () => ({
  ok: true,
  state: "healthy",
  koedHome: "/unused",
  generatedAt: new Date().toISOString(),
  runtimeMode: "local-personal",
  dependencyMode: "bundled-local",
  api: { state: "healthy", url: "http://127.0.0.1:4170" },
  database: { state: "healthy" },
  redis: { state: "healthy" },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  privacyService: { state: "healthy" },
  localAiRuntime: { state: "healthy" },
  apiToken: { state: "healthy", configured: true },
  mcpServer: { state: "healthy" },
  captureHook: { state: "healthy" },
  codex: { state: "healthy", configured: true },
  aiClients: {
    codex: {
      installed: { state: "healthy" },
      authentication: "authenticated",
      capabilities: [{ id: "mcp_recall", readiness: "ready" }]
    }
  },
  lcmSummaryService: { state: "healthy" },
  upstreamBackends: {
    state: "healthy",
    registered: 0,
    validated: 0,
    stale: 0,
    failed: 0,
    notChecked: 0
  },
  lastVerification: { state: "healthy", checkedAt: new Date().toISOString() }
});

const createHarness = (
  existingHome?: string,
  failFirstProviderSetup = false,
  options: {
    codexAuth?: string;
    authOnStderr?: boolean;
    backendHealthy?: boolean;
    providerConfigured?: boolean;
    coldServices?: boolean;
    coreDependencyDown?: boolean;
    skipOwnerCredential?: boolean;
    includePi?: boolean;
    failCapabilityRefresh?: boolean;
  } = {}
) => {
  const home =
    existingHome ?? mkdtempSync(resolve(tmpdir(), "koed-hq-onboarding-"));
  if (!existingHome) homes.push(home);
  if (!existingHome && !options.skipOwnerCredential) {
    storeDesktopLocalCredential(home, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: ["personal_collaboration_read"]
    });
  }
  const bin = resolve(home, "bin");
  mkdirSync(bin, { recursive: true });
  const codexPath = resolve(bin, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n");
  chmodSync(codexPath, 0o700);
  const piPath = resolve(bin, "pi");
  if (options.includePi) {
    writeFileSync(piPath, "#!/bin/sh\nexit 0\n");
    chmodSync(piPath, 0o700);
  }
  mkdirSync(resolve(home, "run"), { recursive: true });
  writeFileSync(
    resolve(home, "run/local-ai-runtime.json"),
    JSON.stringify({
      protocolVersion: 1,
      url: "http://127.0.0.1:43123/",
      authorization: `Bearer ${"a".repeat(43)}`,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
  const commands: string[][] = [];
  const setupTimeouts: number[] = [];
  let capabilitiesPublished = false;
  let piConfigured = false;
  let remainingProviderFailures = failFirstProviderSetup ? 1 : 0;
  let providerConfigured = options.providerConfigured ?? false;
  let servicesStarted = false;
  const manager = createKoedServerManager({
    repoRoot: "/repo",
    cliPath: "/repo/cli.js",
    environment: {
      KOED_HOME: home,
      KOED_DESKTOP_HQ_ENABLED: "true",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MEMORY_CODEX_APP_SERVER_BINARY: codexPath,
      KOED_CLAUDE_CODE_EXECUTABLE: resolve(bin, "missing-claude"),
      KOED_PI_EXECUTABLE: options.includePi
        ? piPath
        : resolve(bin, "missing-pi")
    },
    personalMemoryFetch: async (url, init) => {
      expect(String(url)).toBe(
        "http://127.0.0.1:43123/v1/capabilities/refresh"
      );
      expect(init?.method).toBe("POST");
      commands.push(["capabilities-refresh"]);
      capabilitiesPublished = !options.failCapabilityRefresh;
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          publications: [
            {
              instanceId: "pi.default",
              published: capabilitiesPublished,
              error: capabilitiesPublished ? null : "Publication failed"
            }
          ]
        })
      );
    },
    createCliInvocation: (args) => ({ command: "/node", args, env: {} }),
    existsSync: () => true,
    execFile: (command, args, _options, callback) => {
      commands.push([command, ...args]);
      if (args[0] === "setup" && args[1] === "codex")
        setupTimeouts.push(_options.timeout);
      if (command.endsWith("/pi") && options.includePi) {
        callback(
          null,
          args.includes("--version")
            ? "0.60.0"
            : "provider model\nopenai gpt-test",
          ""
        );
        return;
      }
      if (command.endsWith("/codex")) {
        const auth = options.codexAuth ?? "Logged in";
        callback(
          null,
          args[0] === "--version"
            ? "codex 1.0"
            : options.authOnStderr
              ? ""
              : auth,
          args[0] === "--version" || !options.authOnStderr ? "" : auth
        );
        return;
      }
      if (command === "claude" || command === "pi") {
        callback(new Error("not installed"), "", "");
        return;
      }
      if (
        args[0] === "setup" &&
        args[1] === "codex" &&
        remainingProviderFailures > 0
      ) {
        remainingProviderFailures -= 1;
        callback(
          null,
          JSON.stringify({ ok: false, error: "Provider setup failed." }),
          ""
        );
        return;
      }
      if (args[0] === "setup" && args[1] === "codex") providerConfigured = true;
      if (args[0] === "setup" && args[1] === "pi") piConfigured = true;
      if (args[0] === "start" && args[1] === "--daemon") servicesStarted = true;
      const payload =
        args[0] === "status"
          ? {
              ...readyStatus(),
              ...(options.includePi
                ? {
                    pi: { configured: piConfigured, state: "healthy" },
                    aiClients: {
                      ...readyStatus().aiClients,
                      pi: {
                        installed: { state: "healthy" },
                        authentication: "authenticated",
                        capabilities: [
                          {
                            id: "mcp_recall",
                            readiness: capabilitiesPublished
                              ? "ready"
                              : "unavailable"
                          }
                        ]
                      }
                    }
                  }
                : {}),
              ...(options.coreDependencyDown
                ? {
                    database: { state: "needs_attention" }
                  }
                : {}),
              ...(options.backendHealthy === false ||
              (options.coldServices && !servicesStarted)
                ? {
                    api: {
                      state: "needs_attention",
                      url: "http://127.0.0.1:4170"
                    }
                  }
                : {}),
              codex: {
                state: providerConfigured ? "healthy" : "not_configured",
                configured: providerConfigured
              }
            }
          : args[0] === "package"
            ? { ok: true, state: "installed" }
            : args[0] === "runtime"
              ? { ok: true, state: "installed" }
              : args[0] === "models"
                ? {
                    ok: true,
                    state: "installed",
                    message: "Model verified.",
                    modelPath: "/models/ready"
                  }
                : { ok: true, state: "healthy" };
      callback(null, JSON.stringify(payload), "");
    },
    spawn: () => {
      throw new Error("Backend must not start before Memory.");
    },
    openExternal: async () => undefined
  });
  type HqCommand =
    | "hq_onboarding_status"
    | "hq_onboarding_discover"
    | "hq_onboarding_connect"
    | "hq_onboarding_prepare_core"
    | "hq_onboarding_prepare_memory";
  const handlers = manager.handlers as Omit<
    typeof manager.handlers,
    HqCommand
  > & {
    hq_onboarding_status: (
      args?: Record<string, unknown>
    ) => Promise<HqOnboardingStatus>;
    hq_onboarding_discover: (
      args?: Record<string, unknown>
    ) => Promise<HqOnboardingStatus>;
    hq_onboarding_connect: (
      args?: Record<string, unknown>
    ) => Promise<HqOnboardingStatus>;
    hq_onboarding_prepare_core: (
      args?: Record<string, unknown>
    ) => Promise<HqOnboardingStatus>;
    hq_onboarding_prepare_memory: (
      args?: Record<string, unknown>
    ) => Promise<HqOnboardingStatus>;
  };
  return { manager: { ...manager, handlers }, commands, home, setupTimeouts };
};

describe("HQ onboarding main-owned bridge", () => {
  it("rejects malformed or linked private onboarding state", () => {
    const home = mkdtempSync(resolve(tmpdir(), "koed-hq-state-"));
    homes.push(home);
    const path = hqOnboardingStatePath(home);
    const original = ensureHqOnboardingState(path);
    expect(readHqOnboardingState(path)?.profileKey).toBe(original.profileKey);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 2,
        profileKey: "not-a-key",
        selected: ["codex"],
        memoryEntered: false
      }),
      { mode: 0o600 }
    );
    expect(() => readHqOnboardingState(path)).toThrow("malformed");
    rmSync(path);
    const target = resolve(home, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => readHqOnboardingState(path)).toThrow("private regular file");
  });

  it("rejects direct HQ mutations without strict consent and driver", async () => {
    const { manager, commands } = createHarness();
    expect(() =>
      manager.handlers.hq_onboarding_connect!({ driver: "codex" })
    ).toThrow("Invalid HQ onboarding Connect");
    expect(() =>
      manager.handlers.hq_onboarding_connect!({
        driver: "other",
        operatorConsented: true
      })
    ).toThrow("Invalid HQ onboarding Connect");
    await expect(
      manager.handlers.hq_onboarding_prepare_memory!()
    ).rejects.toThrow("explicit operator consent");
    expect(commands).toEqual([]);
  });
  it("keeps Agent status lightweight and selects an installed client only on explicit Connect", async () => {
    const { manager, commands } = createHarness();
    const first = await manager.handlers.hq_onboarding_status!();
    expect(commands).toEqual([]);
    expect(
      first.clients.find((client) => client.driver === "codex")
    ).toMatchObject({
      selected: false,
      configured: false,
      memoryConnected: false
    });
    const discovered = await manager.handlers.hq_onboarding_discover!();
    expect(
      discovered.clients.find((client) => client.driver === "codex")
    ).toMatchObject({
      installed: true,
      authenticated: "yes",
      selected: false,
      configured: false
    });
    const connected = await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    expect(
      connected.clients.find((client) => client.driver === "codex")
    ).toMatchObject({
      selected: true,
      configured: false,
      memoryConnected: false
    });
    expect(
      commands.some((args) =>
        ["start", "setup", "runtime", "models"].includes(args[1] ?? args[0]!)
      )
    ).toBe(false);
  });

  it("deduplicates Memory preparation and keeps selection across manager restart", async () => {
    const { manager, commands, home } = createHarness();
    await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    const first = await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    const second = await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    expect(["preparing", "ready"]).toContain(first.memoryState);
    expect(["preparing", "ready"]).toContain(second.memoryState);
    const deadline = Date.now() + 2000;
    let status = await manager.handlers.hq_onboarding_status!();
    while (status.memoryState === "preparing" && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
      status = await manager.handlers.hq_onboarding_status!();
    }
    expect(status).toMatchObject({ memoryState: "ready", error: null });
    expect(
      commands.filter(
        (args) => args.includes("setup") && args.includes("codex")
      )
    ).toHaveLength(1);
    expect(
      await manager.handlers.hq_onboarding_prepare_memory!({
        operatorConsented: true
      })
    ).toMatchObject({ memoryState: "ready", error: null });
    expect(
      commands.filter(
        (args) => args.includes("setup") && args.includes("codex")
      )
    ).toHaveLength(1);
    expect(commands.some((args) => args.includes("start"))).toBe(false);
    const resumed = await createHarness(home, false, {
      providerConfigured: true
    }).manager.handlers.hq_onboarding_status!();
    expect(resumed.profileKey).toBe(status.profileKey);
    expect(resumed.memoryState).toBe("ready");
    expect(
      resumed.clients.find((client) => client.driver === "codex")?.selected
    ).toBe(true);
    const down = await createHarness(home, false, {
      providerConfigured: true,
      backendHealthy: false
    }).manager.handlers.hq_onboarding_status!();
    expect(down.memoryState).toBe("failed");
    expect(
      down.clients.find((client) => client.driver === "codex")?.memoryConnected
    ).toBe(false);
    const dependencyDown = await createHarness(home, false, {
      providerConfigured: true,
      coreDependencyDown: true
    }).manager.handlers.hq_onboarding_status!();
    expect(dependencyDown.memoryState).toBe("failed");
  });

  it.each([
    ["Logged in", "yes"],
    ["Not logged in", "no"]
  ])("reads Codex auth from stderr: %s", async (auth, expected) => {
    const { manager } = createHarness(undefined, false, {
      codexAuth: auth,
      authOnStderr: true
    });
    const status = await manager.handlers.hq_onboarding_discover!();
    expect(
      status.clients.find((client) => client.driver === "codex")?.authenticated
    ).toBe(expected);
    if (expected === "no") {
      await expect(
        manager.handlers.hq_onboarding_connect!({
          driver: "codex",
          operatorConsented: true
        })
      ).rejects.toThrow("codex login");
      expect(
        (await manager.handlers.hq_onboarding_status!()).clients.find(
          (client) => client.driver === "codex"
        )?.selected
      ).toBe(false);
    }
  });

  it("reports a failed provider setup and retries on explicit Memory action", async () => {
    const { manager, commands } = createHarness(undefined, true);
    await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    const awaitSettled = async () => {
      const deadline = Date.now() + 2000;
      let status = await manager.handlers.hq_onboarding_status!();
      while (status.memoryState === "preparing" && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 5));
        status = await manager.handlers.hq_onboarding_status!();
      }
      return status;
    };
    await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    const failed = await awaitSettled();
    expect(failed).toMatchObject({
      memoryState: "failed",
      error: "Provider setup failed.",
      progress: {
        message: "Connecting Codex to Memory…",
        completedSteps: 6,
        totalSteps: 8
      }
    });
    await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    const recovered = await awaitSettled();
    expect(recovered).toMatchObject({
      memoryState: "ready",
      error: null,
      progress: {
        message: "Local Memory is ready.",
        completedSteps: 8,
        totalSteps: 8
      }
    });
    expect(recovered.profileKey).toBe(failed.profileKey);
    expect(
      recovered.clients.find((client) => client.driver === "codex")?.selected
    ).toBe(true);
    expect(recovered.progress!.startedAt).toBeGreaterThanOrEqual(
      failed.progress!.startedAt
    );
    expect(
      commands.filter(
        (args) => args.includes("setup") && args.includes("codex")
      )
    ).toHaveLength(2);
  });

  it.each([false, true])(
    "publishes newly configured Pi capabilities before verifying Memory (refresh failure: %s)",
    async (failCapabilityRefresh) => {
      const { manager, commands, setupTimeouts } = createHarness(
        undefined,
        false,
        {
          includePi: true,
          failCapabilityRefresh
        }
      );
      for (const driver of ["codex", "pi"]) {
        await manager.handlers.hq_onboarding_connect!({
          driver,
          operatorConsented: true
        });
      }
      await manager.handlers.hq_onboarding_prepare_memory!({
        operatorConsented: true
      });
      const deadline = Date.now() + 2000;
      let status = await manager.handlers.hq_onboarding_status!();
      while (status.memoryState === "preparing" && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 5));
        status = await manager.handlers.hq_onboarding_status!();
      }
      expect(setupTimeouts).toEqual([420_000]);
      const piSetup = commands.findIndex(
        (args) => args.includes("setup") && args.includes("pi")
      );
      const refresh = commands.findIndex(
        (args) => args[0] === "capabilities-refresh"
      );
      expect(piSetup).toBeGreaterThan(-1);
      expect(refresh).toBeGreaterThan(piSetup);
      if (failCapabilityRefresh) {
        expect(status.memoryState).toBe("failed");
        expect(status.error).toContain("Capability publication failed");
      } else {
        expect(status).toMatchObject({ memoryState: "ready", error: null });
        expect(
          status.clients.find((client) => client.driver === "pi")
        ).toMatchObject({ selected: true, memoryConnected: true });
        expect(
          commands.slice(refresh + 1).some((args) => args.includes("status"))
        ).toBe(true);
      }
    }
  );

  it("keeps the latest setup failure visible despite cached client readiness", async () => {
    const { manager, home } = createHarness(undefined, true, {
      providerConfigured: true,
      skipOwnerCredential: true
    });
    await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    const deadline = Date.now() + 2000;
    let status = await manager.handlers.hq_onboarding_status!();
    while (status.memoryState === "preparing" && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
      status = await manager.handlers.hq_onboarding_status!();
    }
    expect(status.memoryState).toBe("failed");
    storeDesktopLocalCredential(home, {
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      operationFamilies: ["personal_collaboration_read"]
    });
    status = await manager.handlers.hq_onboarding_status!();
    expect(
      status.clients.find((client) => client.driver === "codex")
        ?.memoryConnected
    ).toBe(true);
    expect(status.memoryState).toBe("failed");
    expect(status.error).toBe("Provider setup failed.");
  });

  it("starts missing local services only after entering Memory", async () => {
    const { manager, commands } = createHarness(undefined, false, {
      coldServices: true
    });
    await manager.handlers.hq_onboarding_status!();
    await manager.handlers.hq_onboarding_discover!();
    await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    expect(
      commands.some((args) =>
        ["start", "setup", "runtime", "models"].includes(args[1] ?? args[0]!)
      )
    ).toBe(false);
    await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    const deadline = Date.now() + 2000;
    let status = await manager.handlers.hq_onboarding_status!();
    while (status.memoryState === "preparing" && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
      status = await manager.handlers.hq_onboarding_status!();
    }
    expect(status).toMatchObject({ memoryState: "ready", error: null });
    expect(
      commands.filter(
        (args) => args.includes("start") && args.includes("--daemon")
      )
    ).toHaveLength(1);
    expect(
      commands.filter(
        (args) => args.includes("setup") && args.includes("codex")
      )
    ).toHaveLength(1);
    expect(commands.some((args) => args.includes("upstream"))).toBe(false);
  });

  it("sets Koed itself up before any AI Client is chosen, and Memory reuses it", async () => {
    const { manager, commands } = createHarness(undefined, false, {
      coldServices: true
    });
    await expect(
      manager.handlers.hq_onboarding_prepare_core!()
    ).rejects.toThrow("explicit operator consent");
    const started = await manager.handlers.hq_onboarding_prepare_core!({
      operatorConsented: true
    });
    expect(started.clients.every((client) => !client.selected)).toBe(true);
    expect(started.clients.every((client) => client.error === null)).toBe(true);
    const deadline = Date.now() + 2000;
    let status = await manager.handlers.hq_onboarding_status!();
    while (status.coreState === "preparing" && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
      status = await manager.handlers.hq_onboarding_status!();
    }
    expect(status.coreState).toBe("ready");
    expect(status.memoryState).toBe("not_started");
    const daemonStarts = () =>
      commands.filter(
        (args) => args.includes("start") && args.includes("--daemon")
      ).length;
    expect(daemonStarts()).toBe(1);
    expect(commands.some((args) => args.includes("setup"))).toBe(false);
    await manager.handlers.hq_onboarding_discover!();
    await manager.handlers.hq_onboarding_connect!({
      driver: "codex",
      operatorConsented: true
    });
    await manager.handlers.hq_onboarding_prepare_memory!({
      operatorConsented: true
    });
    status = await manager.handlers.hq_onboarding_status!();
    while (status.memoryState === "preparing" && Date.now() < deadline + 2000) {
      await new Promise((done) => setTimeout(done, 5));
      status = await manager.handlers.hq_onboarding_status!();
    }
    expect(status).toMatchObject({ memoryState: "ready", error: null });
    expect(daemonStarts()).toBe(1);
    expect(
      commands.filter(
        (args) => args.includes("setup") && args.includes("codex")
      )
    ).toHaveLength(1);
  });
});
