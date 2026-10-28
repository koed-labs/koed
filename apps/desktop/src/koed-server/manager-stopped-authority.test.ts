import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createKoedServerManager } from "./manager.js";

const initialize = (
  child: EventEmitter,
  message: Record<string, unknown>,
  childPid: number,
  state: { initializing: boolean }
) => {
  const ready = () =>
    child.emit("message", {
      type: "koed.desktop.supervisor.ready",
      nonce: message.nonce,
      childPid,
      bundleDigest: "a".repeat(64),
      mode: message.mode
    });
  if (message.mode !== "privacy-management") return queueMicrotask(ready);
  if (state.initializing)
    return queueMicrotask(() => child.emit("exit", 1, null));
  state.initializing = true;
  setTimeout(() => {
    state.initializing = false;
    ready();
  }, 20);
};

const managementRaceSpawn = (
  requests: Record<string, unknown>[] = [],
  onInitialize: () => void = () => undefined
) => {
  const state = { initializing: false };
  let pid = 12000;
  return vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      killed: false,
      pid: pid++,
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
      send(message: Record<string, unknown>) {
        requests.push(message);
        if (message.type === "koed.desktop.supervisor.init") {
          initialize(child, message, child.pid, state);
          onInitialize();
        } else
          queueMicrotask(() =>
            child.emit("message", {
              ...message,
              type:
                message.type === "koed.desktop.status.request"
                  ? "koed.desktop.status.response"
                  : "koed.desktop.privacy.response",
              result:
                message.type === "koed.desktop.status.request"
                  ? { ok: true, state: "stopped" }
                  : {
                      required: ["privacy"],
                      components: { privacy: "missing" },
                      activeGeneration: null,
                      requiredManifestPinsAvailable: true
                    }
            })
          );
      }
    });
    return child;
  });
};

const createManager = (spawn: ReturnType<typeof managementRaceSpawn>) =>
  createKoedServerManager({
    repoRoot: "/repo",
    cliPath: "/repo/cli.js",
    environment: {
      KOED_HOME: "/home/test/.koed",
      KOED_TEAM_COLLABORATION_ENABLED: "true"
    },
    createCliInvocation: (args) => ({ command: "/node", args, env: {} }),
    createSupervisorInvocation: () => ({
      command: "/electron",
      args: ["private-entry.js"],
      env: {}
    }),
    packagedResourcesPath: "/app/Contents/Resources",
    productVersion: "0.8.1",
    existsSync: () => true,
    execFile: (_command, _args, _options, callback) => callback(null, "{}", ""),
    spawn: spawn as never,
    openExternal: async () => undefined
  });

it("serializes stopped Privacy status and daemon preflight management startup", async () => {
  const spawn = managementRaceSpawn();
  const manager = createManager(spawn);
  const [privacy, start] = await Promise.all([
    manager.privacyInstall.getStatus(),
    manager.handlers.start_daemon()
  ]);
  expect(privacy).toMatchObject({ available: true, state: "not_installed" });
  expect(start).toMatchObject({ ok: true, state: "starting" });
  expect(spawn).toHaveBeenCalledTimes(3);
});

it("serializes stopped AI Client setup with Privacy status", async () => {
  const spawn = managementRaceSpawn();
  const manager = createManager(spawn);
  const [privacy, setup] = await Promise.all([
    manager.privacyInstall.getStatus(),
    manager.handlers.setup_codex()
  ]);
  expect(privacy).toMatchObject({ available: true });
  expect(setup).toMatchObject({ ok: true });
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("cancels a queued Privacy installation before sending install RPC", async () => {
  const requests: Record<string, unknown>[] = [];
  let initializing = 0;
  let cancellation: Promise<void> | undefined;
  const spawn = managementRaceSpawn(requests, () => {
    if (++initializing === 2)
      setTimeout(() => {
        cancellation = manager.privacyInstall.cancel();
      }, 1);
  });
  const manager = createManager(spawn);
  const results = await Promise.allSettled([
    manager.privacyInstall.installPrivacy({
      consent: true,
      onProgress: () => undefined
    }),
    manager.handlers.doctor()
  ]);
  await cancellation;
  expect(cancellation).toBeDefined();
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("fulfilled");
  expect(
    requests.filter(
      (message) =>
        message.type === "koed.desktop.privacy.request" &&
        message.action === "install"
    )
  ).toHaveLength(0);
});
