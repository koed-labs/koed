import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { PiManagedConversationSession } from "../src/pi-managed-conversation.js";
import { piSessionIdentity } from "../src/pi-transcript-watcher.js";

const directories: string[] = [];
const sessions: PiManagedConversationSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.closeAndWait();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe.runIf(process.env.KOED_RUN_PI_MANAGED_NATIVE === "1")(
  "installed Pi managed adapter",
  () => {
    it("resumes exact source in a different workspace and natively forks without altering the parent", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-pi-native-"));
      directories.push(root);
      const sourceCwd = path.join(root, "source");
      const targetCwd = path.join(root, "target");
      const sessionDirectory = path.join(root, "sessions");
      for (const directory of [sourceCwd, targetCwd, sessionDirectory])
        fs.mkdirSync(directory);
      const sessionId = randomUUID();
      const transcriptPath = path.join(sessionDirectory, `${sessionId}.jsonl`);
      const timestamp = new Date().toISOString();
      const parentBytes = Buffer.from(
        [
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp,
            cwd: sourceCwd
          },
          {
            type: "message",
            id: "11111111",
            parentId: null,
            timestamp,
            message: {
              role: "user",
              content: "Synthetic completed turn",
              timestamp: Date.now()
            }
          },
          {
            type: "message",
            id: "22222222",
            parentId: "11111111",
            timestamp,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Synthetic response" }],
              api: "openai-responses",
              provider: "openai-codex",
              model: "gpt-5.4",
              stopReason: "stop",
              timestamp: Date.now(),
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0
                }
              }
            }
          }
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n"
      );
      fs.writeFileSync(transcriptPath, parentBytes, { mode: 0o600 });
      const model = process.env.KOED_PI_MANAGED_TEST_MODEL;
      if (!model)
        throw new Error(
          "KOED_PI_MANAGED_TEST_MODEL must identify an authenticated model."
        );
      const session = new PiManagedConversationSession({
        cwd: targetCwd,
        model,
        permissionMode: "supervised",
        sessionDirectory,
        resumeSessionPath: transcriptPath,
        expectedSessionId: sessionId,
        env: { ...process.env, KOED_HOME: path.join(root, "koed") },
        requestTimeoutMs: 30_000,
        onUiRequest: async () => ({ cancelled: true })
      });
      sessions.push(session);
      expect(await session.start()).toMatchObject({
        sessionId,
        transcriptPath
      });
      await session.closeAndWait();
      const resumedBytes = fs.readFileSync(transcriptPath);
      expect(resumedBytes.subarray(0, parentBytes.length)).toEqual(parentBytes);
      const forkSession = new PiManagedConversationSession({
        cwd: targetCwd,
        model,
        permissionMode: "supervised",
        sessionDirectory,
        forkSourcePath: transcriptPath,
        expectedParentSessionId: sessionId,
        env: { ...process.env, KOED_HOME: path.join(root, "koed") },
        requestTimeoutMs: 30_000,
        onUiRequest: async () => ({ cancelled: true })
      });
      sessions.push(forkSession);
      const fork = await forkSession.start();
      expect(fork.sessionId).not.toBe(sessionId);
      expect(piSessionIdentity(fork.transcriptPath!)).toMatchObject({
        id: fork.sessionId,
        cwd: targetCwd,
        parentSession: transcriptPath
      });
      expect(fs.readFileSync(transcriptPath)).toEqual(resumedBytes);
    }, 60_000);
  }
);
