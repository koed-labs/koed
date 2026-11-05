import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  requestPeerOnlineControl,
  startPeerOnlineControl
} from "./peer-online-control.js";

const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "koed-ipc-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("peer online control unavailable lifecycle", () => {
  it("fails before invoking even an abort-aware handler or opening a listener", async () => {
    const dir = await directory();
    let invoked = false;
    const result = await startPeerOnlineControl(dir, (_request, signal) => {
      invoked = true;
      signal.addEventListener("abort", () => {});
      return null;
    }).then(
      async (server) => {
        await server.close();
        return "started";
      },
      () => "disabled"
    );
    expect(result).toBe("disabled");
    expect(invoked).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("repeated startup failures do not leak file descriptors", async () => {
    const dir = await directory();
    const before = (await readdir("/dev/fd")).length;
    for (let i = 0; i < 20; i++) {
      await expect(startPeerOnlineControl(dir, () => null)).rejects.toThrow();
    }
    const after = (await readdir("/dev/fd")).length;
    expect(after).toBeLessThanOrEqual(before);
    expect(await readdir(dir)).toEqual([]);
  });

  it("exits a child process after failed startup", async () => {
    const dir = await directory();
    const modulePath = fileURLToPath(
      new URL("./peer-online-control.ts", import.meta.url)
    );
    const code = `const { startPeerOnlineControl } = await import(${JSON.stringify(modulePath)}); for (let i = 0; i < 20; i++) { try { await startPeerOnlineControl(${JSON.stringify(dir)}, () => null); process.exitCode = 1; } catch {} }`;
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { timeout: 3000 }
    );
  });

  it("preserves existing paths and does not enable the client", async () => {
    const dir = await directory();
    const path = join(dir, "peer-online.sock");
    await writeFile(path, "preserve");
    await expect(startPeerOnlineControl(dir, () => null)).rejects.toThrow();
    await expect(requestPeerOnlineControl(dir, null)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("preserve");
  });
});
