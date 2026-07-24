#!/usr/bin/env node
/** PROTOTYPE — scratch PostgreSQL harness; it deletes its cluster on exit. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const pgBin = existsSync("/opt/homebrew/opt/postgresql@17/bin/postgres")
  ? "/opt/homebrew/opt/postgresql@17/bin"
  : "/opt/homebrew/bin";
const pg = (name) => join(pgBin, name);
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...options.env }
  });
  if (result.status !== 0) {
    if (options.capture)
      process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Error(`${program} exited with ${result.status}`);
  }
};
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });

const temp = mkdtempSync(join(tmpdir(), "koed-lcm-generation-"));
const data = join(temp, "data");
const socket = join(temp, "socket");
const user = process.env.USER ?? "postgres";
const port = await freePort();
let started = false;
try {
  // The worker is imported from its built production package, not duplicated.
  run("pnpm", ["--filter", "@koed/core", "build"]);
  run("pnpm", ["--filter", "@koed/db", "build"]);
  run("pnpm", ["--filter", "@koed/mcp-server", "build"]);
  run(pg("initdb"), ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  run("mkdir", ["-p", socket]);
  run(pg("pg_ctl"), [
    "-D",
    data,
    "-o",
    `-F -k ${socket} -h 127.0.0.1 -p ${port}`,
    "-w",
    "start"
  ]);
  started = true;
  run(pg("createdb"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    user,
    "lcm_generation_spike"
  ]);
  const databaseUrl = `postgresql://${encodeURIComponent(user)}@127.0.0.1:${port}/lcm_generation_spike`;
  run("pnpm", ["--filter", "@koed/db", "migrate:up"], {
    env: { DATABASE_URL: databaseUrl }
  });
  run(process.execPath, ["spikes/lcm-generation-investigation/spike.mjs"], {
    env: { DATABASE_URL: databaseUrl, SPIKE_ROOT: root, SPIKE_TMP: temp }
  });
} finally {
  if (started)
    spawnSync(pg("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], {
      stdio: "inherit"
    });
  rmSync(temp, { recursive: true, force: true });
}
