// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off
import {
  KoedMemoryAnswerInputSchema,
  KoedMemoryAnswerResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const CONFIG_PATH = path.join(os.homedir(), ".codex-memory", "config.json");

function findKoedRoot(start: string): string | null {
  let current = start;
  for (let index = 0; index < 12; index += 1) {
    if (fs.existsSync(path.join(current, "packages", "mcp-server", "dist", "cli.js"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

function resolveMcpCliPath(): string {
  if (process.env.KOED_MCP_CLI && fs.existsSync(process.env.KOED_MCP_CLI)) {
    return process.env.KOED_MCP_CLI;
  }

  const candidates = [
    process.cwd(),
    __dirname,
    path.join(__dirname, "..", "..", "..", "..", "..", ".."),
    path.join(os.homedir(), "code", "codex-memory-mvp"),
  ];
  for (const candidate of candidates) {
    const root = findKoedRoot(path.resolve(candidate));
    if (root) {
      return path.join(root, "packages", "mcp-server", "dist", "cli.js");
    }
  }

  throw new Error(
    "Unable to find Koed MCP CLI. Set KOED_MCP_CLI to packages/mcp-server/dist/cli.js.",
  );
}

function runKoedMemoryAnswer(input: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cliPath = resolveMcpCliPath();
    const child = childProcess.spawn(
      process.execPath,
      [cliPath, "memory-answer", "--config", CONFIG_PATH],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Koed memory answer timed out after 120s"));
    }, 120_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Koed memory answer exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(JSON.stringify(input));
  });
}

export const koedMemoryAnswer = makeIpcMethod({
  channel: IpcChannels.KOED_MEMORY_ANSWER_CHANNEL,
  payload: KoedMemoryAnswerInputSchema,
  result: KoedMemoryAnswerResultSchema,
  handler: Effect.fn("desktop.ipc.koedMemory.answer")(function* (input) {
    return yield* Effect.promise(() => runKoedMemoryAnswer(input));
  }),
});
