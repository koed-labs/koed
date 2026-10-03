import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { BuildProgressEvent } from "@koed/shared";

const execFile = promisify(execFileCallback);
const commandTimeoutMs = 10_000;
const maxCommandOutputBytes = 2 * 1024 * 1024;

export type BuildWorkspaceObservation = {
  available: boolean;
  branch?: string;
  status: string;
  files: NonNullable<BuildProgressEvent["technical"]>["files"];
  diff?: NonNullable<BuildProgressEvent["technical"]>["diff"];
};

const statusChange = (
  value: string
): "added" | "deleted" | "renamed" | "modified" => {
  if (value.includes("?")) return "added";
  if (value.includes("D")) return "deleted";
  if (value.includes("R") || value.includes("C")) return "renamed";
  return "modified";
};

const safelyRunGit = async (
  cwd: string,
  args: string[]
): Promise<string | null> => {
  try {
    const result = await execFile("git", ["-C", cwd, ...args], {
      timeout: commandTimeoutMs,
      maxBuffer: maxCommandOutputBytes,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0"
      }
    });
    return result.stdout;
  } catch {
    return null;
  }
};

/** Read only Git metadata and diffs rooted at the verified execution cwd. */
export async function captureBuildWorkspace(
  projectPath: string
): Promise<BuildWorkspaceObservation> {
  let cwd: string;
  try {
    cwd = await realpath(projectPath);
  } catch {
    return {
      available: false,
      status: "Project folder unavailable",
      files: []
    };
  }
  const top = await safelyRunGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    return { available: false, status: "Git state unavailable", files: [] };
  }
  const branch = await safelyRunGit(cwd, ["branch", "--show-current"]);
  const porcelain = await safelyRunGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    "."
  ]);
  const nameStatus = await safelyRunGit(cwd, [
    "diff",
    "--name-status",
    "-z",
    "HEAD",
    "--",
    "."
  ]);
  const numstat = await safelyRunGit(cwd, [
    "diff",
    "--numstat",
    "HEAD",
    "--",
    "."
  ]);
  if (porcelain === null || nameStatus === null || numstat === null) {
    return { available: false, status: "Git state unavailable", files: [] };
  }

  const tracked = new Map<
    string,
    "added" | "modified" | "deleted" | "renamed"
  >();
  const names = nameStatus.split("\0").filter(Boolean);
  for (let index = 0; index < names.length; ) {
    const status = names[index++] ?? "";
    const path = names[index++] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    if (renamed) index += 1;
    if (path) tracked.set(path, statusChange(status));
  }
  const changes = porcelain.split("\0").filter(Boolean);
  const files: NonNullable<BuildProgressEvent["technical"]>["files"] = [];
  for (let index = 0; index < changes.length; index += 1) {
    const entry = changes[index] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path || path.length > 2_048) continue;
    const isUntracked = code === "??";
    const kind = tracked.get(path) ?? statusChange(code);
    files.push({ path, change: kind, ...(isUntracked ? {} : {}) });
    if (code.includes("R") && changes[index + 1]) {
      files.push({ path: changes[index + 1]!, change: "renamed" });
      index += 1;
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/u)) {
    const [add, del] = line.split("\t");
    if (add && /^\d+$/u.test(add)) additions += Number(add);
    if (del && /^\d+$/u.test(del)) deletions += Number(del);
  }
  return {
    available: true,
    ...(branch?.trim() ? { branch: branch.trim().slice(0, 512) } : {}),
    status: files.length === 0 ? "No changes observed" : "Changes observed",
    files: files.slice(0, 2_000),
    diff: {
      filesChanged: files.length,
      additions,
      deletions
    }
  };
}

export function compareBuildWorkspaceObservations(
  before: BuildWorkspaceObservation,
  after: BuildWorkspaceObservation
): BuildWorkspaceObservation {
  if (!before.available || !after.available) return after;
  const baseline = new Set(before.files?.map((file) => file.path) ?? []);
  return {
    ...after,
    status:
      after.files?.length === 0
        ? "No changes observed"
        : "Observed while this Job was running; authorship is not established",
    files: after.files?.map((file) => ({
      ...file,
      baseline: baseline.has(file.path)
    }))
  };
}
