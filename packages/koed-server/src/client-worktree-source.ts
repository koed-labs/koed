import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRecordedProjectDirectory } from "@koed-labs/shared";

const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DEPTH = 4;

const claudeSessionsDirectory = (home: string): string =>
  join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions"
  );

const jsonFiles = (root: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(path);
      if (found.length >= MAX_FILES) return;
    }
  };
  walk(root, 0);
  return found;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type ClientWorktreeLink =
  /** The client recorded the main project directory this Conversation's
   * directory was created from. */
  | { state: "worktree"; originPath: string }
  /** The client recorded that the Conversation ran in its own project directory. */
  | { state: "not-a-worktree" };

/**
 * The Claude desktop app records, per local session, the project directory it
 * was started from (`originCwd`) and the directory the session actually ran in
 * (`cwd`, a worktree for a worktree session). This reads that private,
 * app-owned record as an unverified hint: it only supplies a path to check
 * (existence, registry, Git remote), never an assignment. It returns null when
 * the client has no matching record, the format is unfamiliar, or the record
 * disagrees with the recorded directory.
 */
export const readClaudeWorktreeLink = (
  externalSessionId: string | null | undefined,
  recordedCwd: string,
  options: { homeDir?: string } = {}
): ClientWorktreeLink | null => {
  if (!externalSessionId) return null;
  for (const file of jsonFiles(
    claudeSessionsDirectory(options.homeDir ?? homedir())
  )) {
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes(externalSessionId)) continue;
      const session = record(JSON.parse(text));
      if (!session) continue;
      const prior = Array.isArray(session.priorCliSessionIds)
        ? session.priorCliSessionIds
        : [];
      if (
        session.cliSessionId !== externalSessionId &&
        !prior.includes(externalSessionId)
      )
        continue;
      const ran = normalizeRecordedProjectDirectory(
        typeof session.worktreePath === "string" && session.worktreePath
          ? session.worktreePath
          : session.cwd
      );
      const origin = normalizeRecordedProjectDirectory(session.originCwd);
      // The record must describe the directory this Conversation recorded.
      if (!ran || !origin || ran !== recordedCwd) continue;
      return origin === ran
        ? { state: "not-a-worktree" }
        : { state: "worktree", originPath: origin };
    } catch {
      continue;
    }
  }
  return null;
};

/** Per-client worktree links. Only Claude's desktop app records one today:
 * Codex's sub-agents share their parent's directory and Pi records only a
 * directory, so neither has a link to read. */
export const readClientWorktreeLink = (
  conversation: {
    sourceRuntime?: string | null;
    externalSessionId?: string | null;
  },
  recordedCwd: string,
  options: { homeDir?: string } = {}
): ClientWorktreeLink | null =>
  conversation.sourceRuntime === "claude-code"
    ? readClaudeWorktreeLink(
        conversation.externalSessionId,
        recordedCwd,
        options
      )
    : null;
