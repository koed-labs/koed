import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexTranscriptWatcherSignal {
  sourceSessionId?: string;
  transcriptPath?: string;
  turnBoundary?: boolean;
}

export interface CodexTranscriptTurnBoundary {
  observedAt: number;
  sourceOffset: number;
}

const completeSourceOffset = (transcriptPath: string): number | null => {
  try {
    const source = statSync(transcriptPath);
    if (!source.isFile() || source.size === 0) return null;
    const descriptor = openSync(transcriptPath, "r");
    try {
      for (let end = source.size; end > 0; ) {
        const length = Math.min(64 * 1024, end);
        const start = end - length;
        const buffer = Buffer.allocUnsafe(length);
        readSync(descriptor, buffer, 0, length, start);
        const newline = buffer.lastIndexOf(0x0a);
        if (newline >= 0) return start + newline + 1;
        end = start;
      }
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // A wake still succeeds when the source frontier cannot be verified.
  }
  return null;
};

const koedHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed"));

export const watcherWakePath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(koedHome(env), "run", "codex-transcript-watcher.wake");

const signalIdentity = (kind: "session" | "path", value: string): string =>
  `${kind}-${createHash("sha256").update(value).digest("hex")}`;

const turnBoundaryPaths = (
  env: NodeJS.ProcessEnv,
  input: Pick<
    CodexTranscriptWatcherSignal,
    "sourceSessionId" | "transcriptPath"
  >
): string[] => {
  const directory = path.join(
    koedHome(env),
    "run",
    "codex-transcript-boundaries"
  );
  const identities = [
    ...(input.sourceSessionId
      ? [signalIdentity("session", input.sourceSessionId)]
      : []),
    ...(input.transcriptPath
      ? [signalIdentity("path", path.resolve(input.transcriptPath))]
      : [])
  ];
  return [...new Set(identities)].map((identity) =>
    path.join(directory, `${identity}.json`)
  );
};

const writePrivateSignal = (target: string, content: string): void => {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, target);
};

export const signalCodexTranscriptWatcher = (
  env: NodeJS.ProcessEnv = process.env,
  signal: CodexTranscriptWatcherSignal = {},
  writeSignal: (target: string, content: string) => void = writePrivateSignal
): void => {
  const observedAt = Date.now();
  try {
    const sourceOffset =
      signal.turnBoundary === true && signal.transcriptPath
        ? completeSourceOffset(signal.transcriptPath)
        : null;
    if (sourceOffset !== null) {
      const content = `${JSON.stringify({
        version: 2,
        observedAt,
        sourceOffset
      })}\n`;
      for (const target of turnBoundaryPaths(env, signal)) {
        try {
          writeSignal(target, content);
        } catch {
          // One routing identity may still succeed, and the wake must still run.
        }
      }
    }
  } catch {
    // Boundary delivery is best effort; transcript evidence still catches up.
  }
  try {
    // Publish the wake last so another process cannot observe it before a Stop
    // boundary is durable and defer the final assistant fallback indefinitely.
    writeSignal(watcherWakePath(env), `${observedAt}\n`);
  } catch {
    // Wake delivery is best effort; the next signal or startup performs catch-up.
  }
};

export const readCodexTranscriptTurnBoundary = (
  env: NodeJS.ProcessEnv,
  input: Pick<
    CodexTranscriptWatcherSignal,
    "sourceSessionId" | "transcriptPath"
  >
): CodexTranscriptTurnBoundary | null => {
  let latest: CodexTranscriptTurnBoundary | null = null;
  for (const target of turnBoundaryPaths(env, input)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as {
        version?: unknown;
        observedAt?: unknown;
        sourceOffset?: unknown;
      };
      if (
        parsed.version === 2 &&
        typeof parsed.observedAt === "number" &&
        Number.isSafeInteger(parsed.observedAt) &&
        parsed.observedAt >= 0 &&
        typeof parsed.sourceOffset === "number" &&
        Number.isSafeInteger(parsed.sourceOffset) &&
        parsed.sourceOffset > 0
      ) {
        if (!latest || parsed.observedAt > latest.observedAt) {
          latest = {
            observedAt: parsed.observedAt,
            sourceOffset: parsed.sourceOffset
          };
        }
      }
    } catch {
      // Missing or damaged best-effort signals do not block transcript catch-up.
    }
  }
  return latest;
};

export const acknowledgeCodexTranscriptTurnBoundary = (
  env: NodeJS.ProcessEnv,
  input: Pick<
    CodexTranscriptWatcherSignal,
    "sourceSessionId" | "transcriptPath"
  >,
  observedAt: number
): void => {
  for (const target of turnBoundaryPaths(env, input)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as {
        version?: unknown;
        observedAt?: unknown;
      };
      if (parsed.version === 2 && parsed.observedAt === observedAt) {
        unlinkSync(target);
      }
    } catch {
      // A missing, replaced, or damaged signal must not acknowledge newer work.
    }
  }
};
