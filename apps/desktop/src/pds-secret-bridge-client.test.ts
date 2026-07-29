import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPdsSecretBridgeClient } from "./pds-secret-bridge-client.js";
import { startPdsSecretBridge } from "./pds-secret-bridge.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PDS Desktop secret bridge client", () => {
  it("does not wait for stdin when reading a secret", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-client-"));
    directories.push(directory);
    const bridge = await startPdsSecretBridge({
      koedHome: directory,
      providerProgram: process.execPath,
      providerArgs: [],
      store: {
        get: async () => "runtime-secret",
        put: async () => undefined,
        delete: async () => undefined
      }
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    try {
      await expect(
        Promise.race([
          runPdsSecretBridgeClient({
            operation: "get",
            reference: "pds-runtime",
            socketPath:
              bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_SOCKET ?? "",
            token: bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_TOKEN ?? "",
            stdin,
            stdout
          }),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error("bridge client timed out")), 500)
          )
        ])
      ).resolves.toBe(true);
      expect(output).toBe("runtime-secret");
    } finally {
      stdin.destroy();
      stdout.destroy();
      await bridge.close();
    }
  });

  it("reads put values before sending them to the trusted bridge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-client-"));
    directories.push(directory);
    let stored: string | null = null;
    const bridge = await startPdsSecretBridge({
      koedHome: directory,
      providerProgram: process.execPath,
      providerArgs: [],
      store: {
        get: async () => stored,
        put: async (_reference, value) => {
          stored = value;
        },
        delete: async () => {
          stored = null;
        }
      }
    });
    try {
      await expect(
        runPdsSecretBridgeClient({
          operation: "put",
          reference: "pds-runtime",
          socketPath: bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_SOCKET ?? "",
          token: bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_TOKEN ?? "",
          stdin: Readable.from(["runtime-secret"]),
          stdout: new PassThrough()
        })
      ).resolves.toBe(true);
      expect(stored).toBe("runtime-secret");
    } finally {
      await bridge.close();
    }
  });
});
