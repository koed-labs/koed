import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveCodexAppServerBinary,
  runCodexAppServerTurn
} from "./codex-app-server-runner.js";

const writeFakeAppServer = (
  directory: string,
  options: {
    malformedStdout?: string;
    turnStatus?: "completed" | "failed" | "interrupted";
  } = {}
): string => {
  const modulePath = path.join(directory, "fake-codex-app-server.mjs");
  const scriptPath = path.join(directory, "fake-codex-app-server");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${modulePath}" "$@"
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    modulePath,
    `
import readline from "node:readline";

if (process.argv.includes("exec")) {
  console.error("unexpected codex exec invocation");
  process.exit(42);
}
if (!process.argv.includes("app-server") || !process.argv.includes("--listen") || !process.argv.includes("stdio://")) {
  console.error("expected app-server stdio invocation: " + process.argv.join(" "));
  process.exit(43);
}
if (!process.env.CODEX_HOME || process.env.CODEX_HOME === process.env.FAKE_REAL_CODEX_HOME) {
  console.error("expected isolated CODEX_HOME");
  process.exit(44);
}

const lineReader = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const malformedStdout = ${JSON.stringify(options.malformedStdout ?? "")};
const turnStatus = ${JSON.stringify(options.turnStatus ?? "completed")};
let threadId = "thread-test";
let turnId = "turn-test";

lineReader.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (malformedStdout) {
      process.stdout.write(malformedStdout + "\\n");
      return;
    }
    send({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model, modelProvider: "openai", serviceTier: null, cwd: message.params.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, reasoningEffort: null } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-test", delta: "app-server answer" } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0 }, last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: turnStatus, error: turnStatus === "failed" ? { message: "turn failed" } : null, startedAt: 1, completedAt: 2, durationMs: 1000 } } });
    return;
  }
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

describe("Codex app-server runner", () => {
  it("uses legacy binary env names only as app-server binary aliases", () => {
    expect(
      resolveCodexAppServerBinary(
        {
          MEMORY_ANSWER_CODEX_BINARY: "/custom/codex"
        } as NodeJS.ProcessEnv,
        ["MEMORY_ANSWER_CODEX_BINARY"]
      )
    ).toBe("/custom/codex");
    expect(
      resolveCodexAppServerBinary(
        {
          MEMORY_CODEX_APP_SERVER_BINARY: "/new/codex",
          MEMORY_ANSWER_CODEX_BINARY: "/old/codex"
        } as NodeJS.ProcessEnv,
        ["MEMORY_ANSWER_CODEX_BINARY"]
      )
    ).toBe("/new/codex");
  });

  it("runs a turn through app-server stdio without using codex exec", async () => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-app-server-runner-test-")
    );
    const realCodexHome = path.join(tempDirectory, "real-codex-home");
    fs.mkdirSync(realCodexHome, { mode: 0o700 });
    fs.writeFileSync(
      path.join(realCodexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fake" }),
      { mode: 0o600 }
    );

    try {
      const result = await runCodexAppServerTurn(
        "Prompt text",
        {
          appServerBinary: writeFakeAppServer(tempDirectory),
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          cwd: tempDirectory,
          env: {
            ...process.env,
            CODEX_HOME: realCodexHome,
            FAKE_REAL_CODEX_HOME: realCodexHome
          },
          clientName: "koed-test",
          baseInstructions: "Return the answer.",
          developerInstructions: ""
        },
        1000
      );

      expect(result).toMatchObject({
        text: "app-server answer",
        model: "codex-app-server:gpt-5.4-mini:low",
        threadId: "thread-test",
        turnId: "turn-test"
      });
      expect(result.tokenUsage?.last?.cachedInputTokens).toBe(1);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("falls back to the system temp directory when CODEX_HOME is not writable", async () => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-app-server-readonly-test-")
    );
    const realCodexHome = path.join(tempDirectory, "readonly-codex-home");
    fs.mkdirSync(realCodexHome, { mode: 0o500 });

    try {
      const result = await runCodexAppServerTurn(
        "Prompt text",
        {
          appServerBinary: writeFakeAppServer(tempDirectory),
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          cwd: tempDirectory,
          env: {
            ...process.env,
            CODEX_HOME: realCodexHome,
            FAKE_REAL_CODEX_HOME: realCodexHome
          },
          clientName: "koed-test",
          baseInstructions: "Return the answer.",
          developerInstructions: ""
        },
        1000
      );

      expect(result.text).toBe("app-server answer");
    } finally {
      fs.chmodSync(realCodexHome, 0o700);
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects malformed app-server stdout without throwing out of the line handler", async () => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-app-server-malformed-test-")
    );
    const realCodexHome = path.join(tempDirectory, "real-codex-home");
    fs.mkdirSync(realCodexHome, { mode: 0o700 });

    try {
      await expect(
        runCodexAppServerTurn(
          "Prompt text",
          {
            appServerBinary: writeFakeAppServer(tempDirectory, {
              malformedStdout: "not-json"
            }),
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            cwd: tempDirectory,
            env: {
              ...process.env,
              CODEX_HOME: realCodexHome,
              FAKE_REAL_CODEX_HOME: realCodexHome
            },
            clientName: "koed-test",
            baseInstructions: "Return the answer.",
            developerInstructions: ""
          },
          1000
        )
      ).rejects.toThrow("malformed JSON");
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects interrupted turns instead of returning partial text", async () => {
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-app-server-interrupted-test-")
    );
    const realCodexHome = path.join(tempDirectory, "real-codex-home");
    fs.mkdirSync(realCodexHome, { mode: 0o700 });

    try {
      await expect(
        runCodexAppServerTurn(
          "Prompt text",
          {
            appServerBinary: writeFakeAppServer(tempDirectory, {
              turnStatus: "interrupted"
            }),
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            cwd: tempDirectory,
            env: {
              ...process.env,
              CODEX_HOME: realCodexHome,
              FAKE_REAL_CODEX_HOME: realCodexHome
            },
            clientName: "koed-test",
            baseInstructions: "Return the answer.",
            developerInstructions: ""
          },
          1000
        )
      ).rejects.toThrow("interrupted");
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
