import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import process from "node:process";

const root = resolve(import.meta.dirname, "../../..");
const addonPath = resolve(
  root,
  "apps/desktop/dist-electron/background-agent/native/koed_background_xpc.node"
);

test(
  "reclaim flock excludes another process and releases on process death",
  { skip: process.platform !== "darwin", timeout: 5_000 },
  async () => {
    const require = createRequire(import.meta.url);
    const { localControl } = require(addonPath);
    const scratch = resolve(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(resolve(scratch, "flock-"));
    const path = resolve(home, "lock");
    const fd = openSync(path, "w+", 0o600);
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');const a=require(process.argv[1]);const fd=fs.openSync(process.argv[2],'r+');if(!a.localControl.tryReclaimLock(fd))process.exit(2);console.log('locked');setInterval(()=>{},1000)`,
        addonPath,
        path
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    try {
      const [chunk] = await Promise.race([
        once(child.stdout, "data"),
        once(child, "exit").then(([code]) => {
          throw new Error(`lock child exited before readiness: ${code}`);
        })
      ]);
      assert.equal(String(chunk).trim(), "locked");
      assert.equal(localControl.tryReclaimLock(fd), false);
      child.kill("SIGKILL");
      await once(child, "exit");
      assert.equal(localControl.tryReclaimLock(fd), true);
    } finally {
      child.kill("SIGKILL");
      closeSync(fd);
      rmSync(home, { recursive: true, force: true });
    }
  }
);
