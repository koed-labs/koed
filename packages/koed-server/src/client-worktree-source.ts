import { opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeRecordedProjectDirectory } from "@koed-labs/shared";
import { readFolderHintFile } from "./folder-hint-file.js";

const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 4;

const claudeSessionsDirectory = (home: string): string =>
  join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions"
  );

type LookupOptions = {
  homeDir?: string;
  maxEntries?: number;
  maxBytes?: number;
};

export type ClientWorktreeLink =
  | { state: "worktree"; originPath: string }
  | { state: "not-a-worktree" };

export type ClientWorktreeLookup = (
  conversation: {
    sourceRuntime?: string | null;
    externalSessionId?: string | null;
  },
  recordedCwd: string
) => Promise<ClientWorktreeLink | null>;

type ClaudeIndex = Map<string, Map<string, ClientWorktreeLink>>;

const indexRecord = (text: string, index: ClaudeIndex) => {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const session = value as Record<string, unknown>;
  const ran = normalizeRecordedProjectDirectory(
    typeof session.worktreePath === "string" && session.worktreePath
      ? session.worktreePath
      : session.cwd
  );
  const origin = normalizeRecordedProjectDirectory(session.originCwd);
  if (!ran || !origin) return;
  const link: ClientWorktreeLink =
    origin === ran
      ? { state: "not-a-worktree" }
      : { state: "worktree", originPath: origin };
  const prior: unknown[] = Array.isArray(session.priorCliSessionIds)
    ? session.priorCliSessionIds
    : [];
  const byId = index.get(ran) ?? new Map<string, ClientWorktreeLink>();
  for (const id of [session.cliSessionId, ...prior]) {
    if (typeof id === "string" && id && !byId.has(id)) byId.set(id, link);
  }
  if (byId.size) index.set(ran, byId);
};

const buildClaudeIndex = async (options: LookupOptions) => {
  const index: ClaudeIndex = new Map();
  const budget = {
    remaining: Math.min(options.maxBytes ?? MAX_TOTAL_BYTES, MAX_TOTAL_BYTES)
  };
  let remainingEntries = Math.min(
    options.maxEntries ?? MAX_ENTRIES,
    MAX_ENTRIES
  );
  const walk = async (directory: string, depth: number) => {
    if (depth > MAX_DEPTH || remainingEntries <= 0 || budget.remaining <= 0)
      return;
    try {
      const dir = await opendir(directory, { bufferSize: 1 });
      try {
        while (remainingEntries > 0 && budget.remaining > 0) {
          const entry = await dir.read();
          if (!entry) break;
          remainingEntries--;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path, depth + 1);
          else if (entry.isFile() && entry.name.endsWith(".json")) {
            const text = await readFolderHintFile(path, MAX_FILE_BYTES, budget);
            if (text === null) continue;
            try {
              indexRecord(text, index);
            } catch {
              // An unfamiliar or incomplete record is not evidence.
            }
          }
        }
      } finally {
        await dir.close();
      }
    } catch {
      // An unreadable session directory contributes no matches.
    }
  };
  await walk(claudeSessionsDirectory(options.homeDir ?? homedir()), 0);
  return index;
};

/** One lazy, read-only index per hint batch, shared by hits and misses. Claude
 * Desktop records the session's working directory and originCwd; this only
 * supplies a path to corroborate, not a Folder assignment. Other clients do
 * not record a separate worktree origin. */
export const createClientWorktreeLookup = (
  options: LookupOptions = {}
): ClientWorktreeLookup => {
  let index: ReturnType<typeof buildClaudeIndex> | undefined;
  return async ({ sourceRuntime, externalSessionId }, recordedCwd) => {
    if (sourceRuntime !== "claude-code" || !externalSessionId) return null;
    index ??= buildClaudeIndex(options);
    return (await index).get(recordedCwd)?.get(externalSessionId) ?? null;
  };
};
