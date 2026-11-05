import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackDiscoveryStore } from "./peer-online-loopback-discovery.js";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "koed-discovery-test-"));
  roots.push(root);
  return join(root, "private");
}
const first = {
  host: "127.0.0.1" as const,
  port: 1234,
  capability: "a".repeat(64)
};
const second = {
  host: "127.0.0.1" as const,
  port: 5678,
  capability: "b".repeat(64)
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("persistent loopback discovery", () => {
  it("survives restart and clears only the matching record", async () => {
    const dir = setup();
    const store = createLoopbackDiscoveryStore(dir);
    await store.publish(first, new AbortController().signal);
    const restarted = createLoopbackDiscoveryStore(dir);
    expect(await restarted.read()).toEqual(first);
    await restarted.publish(second, new AbortController().signal);
    await store.clear(first);
    expect(await store.read()).toEqual(second);
    await restarted.clear(second);
    expect(await store.read()).toBeUndefined();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "discovery.sqlite")).mode & 0o777).toBe(0o600);
  });
  it("does not publish an aborted or invalid record", async () => {
    const store = createLoopbackDiscoveryStore(setup());
    await store.publish(first, new AbortController().signal);
    const controller = new AbortController();
    controller.abort();
    await expect(store.publish(second, controller.signal)).rejects.toThrow();
    await expect(
      store.publish(
        { ...second, capability: "x".repeat(100000) },
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(await store.read()).toEqual(first);
  });
  it("serializes publication and conditional clearing across processes", async () => {
    const dir = setup();
    const store = createLoopbackDiscoveryStore(dir);
    await store.publish(first, new AbortController().signal);
    const modulePath = fileURLToPath(
      new URL("./peer-online-loopback-discovery.ts", import.meta.url)
    );
    const script = `
      const { createLoopbackDiscoveryStore } = await import(process.argv[1]);
      const store = createLoopbackDiscoveryStore(process.argv[2]);
      const record = { host: "127.0.0.1", port: Number(process.argv[3]), capability: process.argv[4].repeat(64) };
      for (let i = 0; i < 30; i++) {
        await store.publish(record, new AbortController().signal);
        await store.clear(record);
      }
    `;
    const run = (port: string, capability: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            modulePath,
            dir,
            port,
            capability
          ],
          { stdio: ["ignore", "ignore", "pipe"] }
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr))
        );
      });
    await Promise.all([run("2345", "b"), run("3456", "c"), run("4567", "d")]);
    expect(await store.read()).toBeUndefined();
    await store.publish(second, new AbortController().signal);
    await store.clear(first);
    expect(await store.read()).toEqual(second);
  });
  it("rejects oversized stale records without replacing them", async () => {
    const dir = setup();
    const store = createLoopbackDiscoveryStore(dir);
    await store.publish(first, new AbortController().signal);
    const db = new DatabaseSync(join(dir, "discovery.sqlite"));
    db.prepare("UPDATE discovery SET capability = ?").run("x".repeat(100000));
    db.close();
    await expect(store.read()).rejects.toThrow();
    await expect(
      store.publish(second, new AbortController().signal)
    ).rejects.toThrow();
    const verify = new DatabaseSync(join(dir, "discovery.sqlite"), {
      readOnly: true
    });
    expect(
      verify.prepare("SELECT length(capability) AS size FROM discovery").get()
        ?.size
    ).toBe(100000);
    verify.close();
  });
  it("rejects unrelated data and symlinks without overwriting them", async () => {
    const dir = setup();
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "discovery.sqlite");
    writeFileSync(path, "unrelated", { mode: 0o600 });
    await expect(
      createLoopbackDiscoveryStore(dir).publish(
        first,
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("unrelated");
    rmSync(path);
    symlinkSync("missing", path);
    await expect(createLoopbackDiscoveryStore(dir).read()).rejects.toThrow();
  });
});
