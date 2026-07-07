#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const jsonMode = args.includes("--json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const run = (command, commandArgs, { quietStdout = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: quietStdout ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    if (quietStdout) {
      child.stdout.on("data", (chunk) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(
        new Error(`${command} ${commandArgs.join(" ")} failed with ${suffix}`)
      );
    });
  });

try {
  await run(pnpm, ["--filter", "@koed/shared", "build"], {
    quietStdout: jsonMode
  });
  await run(pnpm, ["--filter", "@koed/db", "build"], {
    quietStdout: jsonMode
  });
  await run(process.execPath, [
    "scripts/hosted-encryption-rewrap.mjs",
    ...args
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
