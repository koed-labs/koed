import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPdsSecretBridge } from "./pds-secret-bridge.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const request = async (input: {
  socketPath: string;
  token: string;
  body: Record<string, unknown>;
}): Promise<Record<string, unknown>> =>
  await new Promise((resolvePromise, reject) => {
    const socket = connect(input.socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({ token: input.token, ...input.body })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => resolvePromise(JSON.parse(response)));
  });

describe("PDS Desktop secret bridge", () => {
  it("fails closed when KOED_HOME/run is not private", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-bridge-"));
    directories.push(directory);
    const runDirectory = join(directory, "run");
    // `mkdir` defaults to a private umask here; explicitly make it unsafe.
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runDirectory));
    chmodSync(runDirectory, 0o755);
    await expect(
      startPdsSecretBridge({
        koedHome: directory,
        providerProgram: process.execPath,
        providerArgs: ["bridge-client.js"],
        store: {
          get: async () => null,
          put: async () => undefined,
          delete: async () => undefined
        }
      })
    ).rejects.toThrow("private Koed run directory");
  });

  it("requires its per-launch capability and keeps secret operations bounded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koed-pds-bridge-"));
    directories.push(directory);
    const values = new Map<string, string>();
    const bridge = await startPdsSecretBridge({
      koedHome: directory,
      providerProgram: process.execPath,
      providerArgs: ["bridge-client.js"],
      store: {
        get: async (reference) => values.get(reference) ?? null,
        put: async (reference, value) => void values.set(reference, value),
        delete: async (reference) => void values.delete(reference)
      }
    });
    const socketPath = bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_SOCKET!;
    const token = bridge.environment.PDS_DESKTOP_SECRET_BRIDGE_TOKEN!;
    try {
      if (process.platform !== "win32") {
        expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
      }
      await expect(
        request({
          socketPath,
          token,
          body: { operation: "put", reference: "pds-runtime", value: "secret" }
        })
      ).resolves.toEqual({ ok: true });
      await expect(
        request({
          socketPath,
          token,
          body: { operation: "get", reference: "pds-runtime" }
        })
      ).resolves.toEqual({ ok: true, value: "secret" });
      await expect(
        request({
          socketPath,
          token: "not-the-capability",
          body: { operation: "get", reference: "pds-runtime" }
        })
      ).resolves.toEqual({ ok: false });
    } finally {
      await bridge.close();
    }
  });
});
