import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeTranscriptWatcherSignal {
  sourceSessionId: string;
  transcriptPath: string;
  cwd: string;
  hookEventName?: string;
  turnBoundary?: boolean;
  observedAt?: string;
}

const koedHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed"));

export const claudeWatcherSignalDirectory = (
  env: NodeJS.ProcessEnv = process.env
): string => path.join(koedHome(env), "run", "claude-transcript-signals");

export const claudeWatcherWakePath = (
  env: NodeJS.ProcessEnv = process.env
): string => path.join(koedHome(env), "run", "claude-transcript-watcher.wake");

const writePrivateFile = (target: string, content: string): void => {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, target);
};

export const signalClaudeTranscriptWatcher = (
  env: NodeJS.ProcessEnv,
  signal: ClaudeTranscriptWatcherSignal
): void => {
  const observedAt = signal.observedAt ?? new Date().toISOString();
  const identity = createHash("sha256")
    .update(`${signal.sourceSessionId}\0${path.resolve(signal.transcriptPath)}`)
    .digest("hex");
  const target = path.join(
    claudeWatcherSignalDirectory(env),
    `${identity}.json`
  );
  let priorTurnBoundary = false;
  try {
    if (existsSync(target)) {
      const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
      priorTurnBoundary =
        typeof parsed === "object" &&
        parsed !== null &&
        "turnBoundary" in parsed &&
        parsed.turnBoundary === true;
    }
  } catch {
    priorTurnBoundary = false;
  }
  writePrivateFile(
    target,
    `${JSON.stringify({
      ...signal,
      observedAt,
      turnBoundary: priorTurnBoundary || signal.turnBoundary === true
    })}\n`
  );
  writePrivateFile(claudeWatcherWakePath(env), `${Date.now()}\n`);
};
