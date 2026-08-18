import { createReadStream, mkdirSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { completeTranscriptBoundary } from "./codex-transcript-journal.js";
import type { ClaudeTranscriptWatcherSignal } from "./claude-transcript-watcher-signal.js";
import type { ClaudeWatcherState } from "./claude-transcript-types.js";

const componentCursorKey = (sessionId: string, componentId: string): string =>
  `${sessionId}\u0000${componentId}`;

export interface ClaudeTranscriptIndex {
  timestamps: Map<string, string>;
  activationOffset: number;
  activationLine: number;
  activationTimestamp: string | null;
  lineCount: number;
}

export const transcriptIndex = async (
  transcriptPath: string,
  activatedAt: string
): Promise<ClaudeTranscriptIndex> => {
  const timestamps = new Map<string, string>();
  const activation = Date.parse(activatedAt);
  let activationOffset = -1;
  let activationLine = -1;
  let byteOffset = 0;
  let lineNumber = 0;
  const completeBoundary = completeTranscriptBoundary(transcriptPath);
  if (completeBoundary === 0) {
    return {
      timestamps,
      activationOffset: 0,
      activationLine: 0,
      activationTimestamp: null,
      lineCount: 0
    };
  }
  const input = createReadStream(transcriptPath, {
    encoding: "utf8",
    end: completeBoundary - 1
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) {
      throw new Error("Claude transcript contains an empty complete record");
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof entry.uuid === "string" &&
        typeof entry.timestamp === "string" &&
        Number.isFinite(Date.parse(entry.timestamp))
      ) {
        const timestamp = new Date(entry.timestamp).toISOString();
        timestamps.set(entry.uuid, timestamp);
        if (activationOffset < 0 && Date.parse(timestamp) >= activation) {
          activationOffset = byteOffset;
          activationLine = lineNumber;
        }
      }
    } catch {
      throw new Error("Claude transcript contains a malformed complete record");
    }
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
    lineNumber += 1;
  }
  return {
    timestamps,
    activationOffset: Math.max(0, activationOffset),
    activationLine: Math.max(0, activationLine),
    activationTimestamp:
      activationOffset < 0
        ? null
        : ([...timestamps.values()].find(
            (timestamp) => Date.parse(timestamp) >= activation
          ) ?? null),
    lineCount: lineNumber
  };
};

export const claudeHome = (env: NodeJS.ProcessEnv): string =>
  path.resolve(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));

export const claudeProjectsHome = (env: NodeJS.ProcessEnv): string =>
  path.join(claudeHome(env), "projects");

const transcriptIdentity = async (
  transcriptPath: string
): Promise<{ sessionId: string; cwd: string } | null> => {
  const sessionId = path.basename(transcriptPath, ".jsonl");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId
    )
  ) {
    return null;
  }
  const completeBoundary = completeTranscriptBoundary(transcriptPath);
  if (completeBoundary === 0) return null;
  const input = createReadStream(transcriptPath, {
    encoding: "utf8",
    end: Math.min(completeBoundary, 1024 * 1024) - 1
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let inspected = 0;
  for await (const line of lines) {
    inspected += 1;
    if (inspected > 2_000) break;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        entry.sessionId === sessionId &&
        typeof entry.cwd === "string" &&
        entry.cwd.trim()
      ) {
        lines.close();
        input.destroy();
        return { sessionId, cwd: entry.cwd };
      }
    } catch {
      return null;
    }
  }
  return null;
};

export const discoverClaudeTranscriptSignals = async (
  state: ClaudeWatcherState,
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeTranscriptWatcherSignal[]> => {
  const projectsHome = claudeProjectsHome(env);
  mkdirSync(projectsHome, { recursive: true, mode: 0o700 });
  const activation = Date.parse(state.activatedAt);
  const signals: ClaudeTranscriptWatcherSignal[] = [];
  const projects = (await readdir(projectsHome, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, 1_000);
  for (const project of projects) {
    const projectPath = path.join(projectsHome, project.name);
    const files = (await readdir(projectPath, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".jsonl")
      )
      .slice(0, 10_000);
    for (const file of files) {
      const transcriptPath = path.join(projectPath, file.name);
      const details = await stat(transcriptPath);
      const sourceSessionId = path.basename(file.name, ".jsonl");
      const cursor = state.cursors[componentCursorKey(sourceSessionId, "main")];
      if (cursor && details.mtimeMs <= Date.parse(cursor.updatedAt)) {
        continue;
      }
      if (details.mtimeMs < activation && !cursor) {
        continue;
      }
      const identity = await transcriptIdentity(transcriptPath);
      if (!identity) continue;
      signals.push({
        sourceSessionId: identity.sessionId,
        transcriptPath,
        cwd: identity.cwd,
        hookEventName: "FilesystemRecovery",
        observedAt: new Date(details.mtimeMs).toISOString()
      });
    }
  }
  return signals;
};

export const verifiedTranscriptPath = async (
  transcriptPath: string,
  sourceSessionId: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const [home, candidate] = await Promise.all([
    realpath(claudeHome(env)),
    realpath(path.resolve(transcriptPath))
  ]);
  if (candidate !== home && !candidate.startsWith(`${home}${path.sep}`)) {
    throw new Error("claude_transcript_outside_config_home");
  }
  if (path.basename(candidate) !== `${sourceSessionId}.jsonl`) {
    throw new Error("claude_transcript_session_identity_mismatch");
  }
  const file = await lstat(candidate);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error("claude_transcript_not_regular_file");
  }
  return candidate;
};

export const discoverClaudeHistoricalTranscriptSignals = async (
  sourceSessionIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeTranscriptWatcherSignal[]> => {
  const requested = new Set(sourceSessionIds);
  if (requested.size === 0) {
    throw new Error("claude_historical_import_requires_session_selection");
  }
  const projectsHome = claudeProjectsHome(env);
  const signals: ClaudeTranscriptWatcherSignal[] = [];
  const projects = (await readdir(projectsHome, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .slice(0, 1_000);
  for (const project of projects) {
    const projectPath = path.join(projectsHome, project.name);
    const files = (await readdir(projectPath, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".jsonl") &&
          requested.has(path.basename(entry.name, ".jsonl"))
      )
      .slice(0, 10_000);
    for (const file of files) {
      const transcriptPath = path.join(projectPath, file.name);
      const identity = await transcriptIdentity(transcriptPath);
      if (!identity || !requested.has(identity.sessionId)) continue;
      const details = await stat(transcriptPath);
      signals.push({
        sourceSessionId: identity.sessionId,
        transcriptPath,
        cwd: identity.cwd,
        hookEventName: "HistoricalImport",
        observedAt: details.mtime.toISOString()
      });
    }
  }
  const found = new Set(signals.map((signal) => signal.sourceSessionId));
  const missing = [...requested].filter((sessionId) => !found.has(sessionId));
  if (missing.length > 0) {
    throw new Error(
      `claude_historical_sessions_not_found:${missing.join(",")}`
    );
  }
  return signals;
};
