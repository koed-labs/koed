import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKoedServerManager } from "../koed-server/manager.js";
import { startPdsSecretBridge } from "../pds-secret-bridge.js";
import { createDesktopQuitCoordinator } from "./quit-coordinator.js";

const preservedFiles = [
  "config.json",
  "memory.db",
  "models/embedding.bin",
  "run/secret-reference"
];

const seedKoedHome = (root: string): Record<string, string> => {
  mkdirSync(join(root, "models"));
  mkdirSync(join(root, "run"), { mode: 0o700 });
  chmodSync(join(root, "run"), 0o700);
  const values = {
    "config.json": '{"version":1}\n',
    "memory.db": "personal-memory\n",
    "models/embedding.bin": "model-bytes\n",
    "run/secret-reference": "pds-runtime\n"
  };
  for (const [relative, contents] of Object.entries(values)) {
    writeFileSync(join(root, relative), contents);
  }
  return Object.fromEntries(
    preservedFiles.map((relative) => [
      relative,
      readFileSync(join(root, relative), "utf8")
    ])
  );
};

const createFixture = async () => {
  const koedHome = mkdtempSync(join(tmpdir(), "koed-upd-real-"));
  const before = seedKoedHome(koedHome);
  const stopCalls: string[][] = [];
  const manager = createKoedServerManager({
    repoRoot: "/repo",
    cliPath: "/repo/cli.js",
    environment: { KOED_HOME: koedHome },
    createCliInvocation: (args) => ({
      command: "/node",
      args: ["/repo/cli.js", ...args],
      env: { KOED_REPO_ROOT: "/repo", KOED_HOME: koedHome }
    }),
    existsSync: (path) => path === "/repo/cli.js",
    execFile: (_command, args, _options, callback) => {
      stopCalls.push(args);
      callback(null, JSON.stringify({ ok: true, state: "stopped" }), "");
    },
    spawn: () => ({ killed: false, kill: vi.fn() }) as never,
    openExternal: async () => undefined
  });
  const store = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined
  };
  const bridge = await startPdsSecretBridge({
    koedHome,
    providerProgram: "/node",
    providerArgs: [],
    store
  });
  return { before, bridge, koedHome, manager, stopCalls };
};

const readPreservedFiles = (root: string): Record<string, string> =>
  Object.fromEntries(
    preservedFiles.map((relative) => [
      relative,
      readFileSync(join(root, relative), "utf8")
    ])
  );

describe("Desktop quit coordinator implementation integration", () => {
  it("preserves real KOED_HOME files across normal and updater shutdown", async () => {
    const normal = await createFixture();
    try {
      const normalCoordinator = createDesktopQuitCoordinator({
        getKoedServer: () => normal.manager,
        getPdsSecretBridge: () => normal.bridge
      });
      await normalCoordinator.shutdownServices();
      expect(readPreservedFiles(normal.koedHome)).toEqual(normal.before);
      expect(
        normal.stopCalls.filter((args) => args.includes("stop"))
      ).toHaveLength(1);
    } finally {
      rmSync(normal.koedHome, { recursive: true, force: true });
    }

    const updater = await createFixture();
    try {
      const bridgeClose = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("transient bridge close failure"))
        .mockImplementation(() => updater.bridge.close());
      const updaterCoordinator = createDesktopQuitCoordinator({
        getKoedServer: () => updater.manager,
        getPdsSecretBridge: () => ({
          close: bridgeClose,
          environment: updater.bridge.environment
        })
      });
      await expect(updaterCoordinator.prepareForInstall()).rejects.toThrow(
        "transient bridge close failure"
      );
      await updaterCoordinator.prepareForInstall();
      expect(readPreservedFiles(updater.koedHome)).toEqual(updater.before);
      expect(bridgeClose).toHaveBeenCalledTimes(2);
      expect(
        updater.stopCalls.filter((args) => args.includes("stop"))
      ).toHaveLength(1);
    } finally {
      rmSync(updater.koedHome, { recursive: true, force: true });
    }
  });
});
