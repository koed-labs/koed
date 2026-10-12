import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

/**
 * @typedef {{path: string, content: string | null}} ClaudeBackgroundJournalSnapshot
 * @typedef {{state: "configured" | "preserved" | "disabled" | "environment_override", thresholdMs?: unknown, scope: "all_mcp_calls", message: string}} ClaudeBackgroundRecallStatus
 */
export const CLAUDE_BACKGROUND_THRESHOLD = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
const disableKey = "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";
// Claude Code 2.1.267's native boolean parser accepts these values, ignoring
// case and surrounding whitespace. The public docs recommend "1".
const disabled = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase()
  );
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const assertTarget = (path, privateFile) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (privateFile && process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error(
      "Claude configuration target is not a protected owned regular file"
    );
};
const readProtectedJournal = (path) => {
  assertTarget(path, true);
  if (!existsSync(path)) return null;
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error(
        "Claude background recall journal is not a bounded protected owned file"
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};
const writeAtomic = (path, content, privateFile) => {
  assertTarget(path, privateFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    // Validate again before replacing, including a new symlink or foreign file.
    assertTarget(path, privateFile);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
};
/** @param {string} path @param {string} content */
export function writeClaudeSettingsFileAtomic(path, content) {
  writeAtomic(path, content, false);
}
/** @param {string} koedHome @returns {ClaudeBackgroundJournalSnapshot} */
export function captureClaudeBackgroundJournal(koedHome) {
  const path = join(koedHome, "config", "claude-background-recall.json");
  return { path, content: readProtectedJournal(path) };
}
function records(snapshot) {
  if (snapshot.content === null) return [];
  const journal = JSON.parse(snapshot.content);
  if (
    !object(journal) ||
    journal.version !== 1 ||
    !Array.isArray(journal.entries) ||
    journal.entries.length > 128 ||
    journal.entries.some(
      (entry) =>
        !object(entry) ||
        typeof entry.settingsPath !== "string" ||
        entry.settingsPath.length > 4096 ||
        resolve(entry.settingsPath) !== entry.settingsPath ||
        entry.writtenValue !== "500" ||
        typeof entry.createdEnv !== "boolean"
    )
  )
    throw new Error(
      "Koed Claude background recall ownership journal is invalid"
    );
  if (
    new Set(journal.entries.map((entry) => entry.settingsPath)).size !==
    journal.entries.length
  )
    throw new Error(
      "Koed Claude background recall journal has duplicate settings paths"
    );
  return journal.entries;
}
/** @param {ClaudeBackgroundJournalSnapshot} snapshot @param {string | null} content */
export function writeClaudeBackgroundJournal(snapshot, content) {
  if (content !== null) {
    if (Buffer.byteLength(content, "utf8") > 65536)
      throw new Error(
        "Claude background recall ownership journal byte capacity is exhausted"
      );
    records({ ...snapshot, content });
  }
  readProtectedJournal(snapshot.path);
  if (content === null) {
    if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
    return;
  }
  writeAtomic(snapshot.path, content, true);
}
const serialized = (entries) => {
  if (entries.length > 128)
    throw new Error(
      "Claude background recall ownership journal capacity is exhausted"
    );
  const content = entries.length
    ? `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
    : null;
  if (content !== null && Buffer.byteLength(content, "utf8") > 65536)
    throw new Error(
      "Claude background recall ownership journal byte capacity is exhausted"
    );
  return content;
};
/** @param {ClaudeBackgroundRecallStatus["state"]} state @param {unknown} threshold @param {string} message @returns {ClaudeBackgroundRecallStatus} */
const report = (state, threshold, message) => ({
  state,
  thresholdMs: threshold,
  scope: "all_mcp_calls",
  message
});

// This changes Claude's host settings, never the MCP child's env. An explicit
// setup flag supplies consent for the all-MCP effect; existing choices win.
/**
 * @param {Record<string, unknown>} settings
 * @param {Record<string, string | undefined>} environment
 * @param {string} settingsPath
 * @param {ClaudeBackgroundJournalSnapshot} snapshot
 * @returns {{report: ClaudeBackgroundRecallStatus, journal: string | null}}
 */
export function configureClaudeBackgroundRecall(
  settings,
  environment,
  settingsPath,
  snapshot
) {
  if (!object(settings))
    throw new Error("Claude settings must be a JSON object");
  const entries = records(snapshot);
  if (settings.env !== undefined && !object(settings.env))
    throw new Error(
      "Claude settings.env must be an object before enabling background recall"
    );
  const env = settings.env ?? {};
  if (disabled(env[disableKey]) || disabled(environment[disableKey]))
    return {
      report: report(
        "disabled",
        env[CLAUDE_BACKGROUND_THRESHOLD],
        "Existing Claude background-task disable setting was preserved."
      ),
      journal: snapshot.content
    };
  if (environment[CLAUDE_BACKGROUND_THRESHOLD] !== undefined)
    return {
      report: report(
        String(environment[CLAUDE_BACKGROUND_THRESHOLD]).trim() === "0"
          ? "disabled"
          : "environment_override",
        environment[CLAUDE_BACKGROUND_THRESHOLD],
        "Existing host environment threshold was preserved; Koed did not change settings.env."
      ),
      journal: snapshot.content
    };
  if (own(env, CLAUDE_BACKGROUND_THRESHOLD))
    return {
      report: report(
        String(env[CLAUDE_BACKGROUND_THRESHOLD]).trim() === "0"
          ? "disabled"
          : "preserved",
        env[CLAUDE_BACKGROUND_THRESHOLD],
        "Existing Claude MCP background threshold was preserved."
      ),
      journal: snapshot.content
    };
  const absolutePath = resolve(settingsPath);
  const prior = entries.find((entry) => entry.settingsPath === absolutePath);
  // A stale receipt describes an earlier opt-in. Replacing an absent key starts
  // a new ownership interval, while unrelated settings receipts remain intact.
  const next = entries.filter((entry) => entry !== prior);
  next.push({
    settingsPath: absolutePath,
    writtenValue: "500",
    createdEnv: settings.env === undefined
  });
  const journal = serialized(next);
  settings.env = { ...env, [CLAUDE_BACKGROUND_THRESHOLD]: "500" };
  return {
    report: report(
      "configured",
      "500",
      "Claude main-Conversation MCP calls background after 500 ms. This host setting affects all ordinary MCP calls, not only Koed; restart Claude Code to apply it."
    ),
    journal
  };
}

/**
 * @param {Record<string, unknown>} settings
 * @param {string} settingsPath
 * @param {ClaudeBackgroundJournalSnapshot} snapshot
 * @returns {{journal: string | null}}
 */
export function removeClaudeBackgroundRecall(settings, settingsPath, snapshot) {
  if (!object(settings))
    throw new Error("Claude settings must be a JSON object");
  const entries = records(snapshot);
  const absolutePath = resolve(settingsPath);
  const owned = entries.find((entry) => entry.settingsPath === absolutePath);
  if (!owned) return { journal: snapshot.content };
  // Remove only the exact value Koed inserted. A later user edit wins.
  if (
    object(settings.env) &&
    settings.env[CLAUDE_BACKGROUND_THRESHOLD] === owned.writtenValue
  ) {
    delete settings.env[CLAUDE_BACKGROUND_THRESHOLD];
    if (owned.createdEnv && Object.keys(settings.env).length === 0)
      delete settings.env;
  }
  return { journal: serialized(entries.filter((entry) => entry !== owned)) };
}
