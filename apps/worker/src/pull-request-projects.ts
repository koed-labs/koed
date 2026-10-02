import { execFile as nodeExecFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 200;
const MAX_REMOTES_PER_PROJECT = 10;
const MAX_REMOTES_TOTAL = 1_000;
const MAX_REMOTE_NAME_BYTES = 128;
const MAX_REMOTE_URL_BYTES = 2_048;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 2_000;
const TOTAL_BUDGET_MS = 10_000;

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
};
type Run = (
  binary: string,
  args: string[],
  options: RunOptions
) => Promise<{ stdout: string; stderr?: string }>;
type ProjectRecord = {
  localProjectId: string;
  displayName: string;
  path: { cwd: string; projectRoot: string | null };
};

const fail = (code: string) => Object.assign(new Error(code), { name: code });

const safeEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "SYSTEMROOT"])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0"
  };
};

const defaultRun: Run = async (binary, args, options) => {
  const result = await execFile(binary, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
};

const parseProjectRecords = (value: unknown): ProjectRecord[] => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("PullRequestProjectCatalogInvalid");
  const projects = (value as Record<string, unknown>).projects;
  if (!Array.isArray(projects)) throw fail("PullRequestProjectCatalogInvalid");
  const records: ProjectRecord[] = [];
  for (const entry of projects) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const path = item.path;
    if (
      item.schemaVersion !== 1 ||
      typeof item.localProjectId !== "string" ||
      !/^lp_[a-f0-9]{32}$/i.test(item.localProjectId) ||
      typeof item.displayName !== "string" ||
      !item.displayName.trim() ||
      item.displayName.length > 120 ||
      !path ||
      typeof path !== "object" ||
      Array.isArray(path)
    )
      continue;
    const projectPath = path as Record<string, unknown>;
    if (
      typeof projectPath.cwd !== "string" ||
      !isAbsolute(projectPath.cwd) ||
      (projectPath.projectRoot !== null &&
        (typeof projectPath.projectRoot !== "string" ||
          !isAbsolute(projectPath.projectRoot)))
    )
      continue;
    records.push({
      localProjectId: item.localProjectId,
      displayName: item.displayName.trim(),
      path: {
        cwd: projectPath.cwd,
        projectRoot: projectPath.projectRoot as string | null
      }
    });
  }
  return records;
};

const parseGithubRemote = (value: string): string | null => {
  if (!value || value.length > MAX_REMOTE_URL_BYTES || /[\r\n\0]/.test(value))
    return null;
  let pathname: string;
  if (/^https:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      (parsed.port !== "" && parsed.port !== "443") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return null;
    pathname = parsed.pathname;
  } else {
    const scp = /^git@github\.com:([^\s]+)$/i.exec(value);
    const ssh = /^ssh:\/\/git@github\.com(?::443)?\/([^\s]+)$/i.exec(value);
    if (!scp && !ssh) return null;
    pathname = `/${scp?.[1] ?? ssh?.[1] ?? ""}`;
  }
  const match =
    /^\/?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/i.exec(
      pathname
    );
  if (!match) return null;
  const owner = match[1] ?? "";
  const name = match[2] ?? "";
  if (
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    owner.endsWith(".")
  )
    return null;
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
};

export const listMatchingPullRequestProjects = async (input: {
  koedHome: string;
  repository: string;
  run?: Run;
}): Promise<{
  projects: Array<{ id: string; displayName: string }>;
  truncated: boolean;
}> => {
  if (
    !input ||
    typeof input.koedHome !== "string" ||
    !isAbsolute(input.koedHome) ||
    typeof input.repository !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
    input.repository.split("/").some((part) => part === "." || part === "..")
  )
    throw fail("PullRequestProjectLookupInvalid");
  const expectedRepository = input.repository.toLowerCase();
  const metadataPath = resolve(input.koedHome, "config", "projects.json");
  const canonicalHome = await realpath(input.koedHome).catch(() => null);
  const canonicalMetadata = await realpath(metadataPath).catch(() => null);
  const stat = await lstat(metadataPath).catch(() => null);
  if (
    !canonicalHome ||
    !canonicalMetadata ||
    !canonicalMetadata.startsWith(`${canonicalHome}${sep}`) ||
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_CATALOG_BYTES
  )
    return { projects: [], truncated: false };
  let records: ProjectRecord[];
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8"));
    records = parseProjectRecords(parsed);
  } catch {
    return { projects: [], truncated: false };
  }
  let truncated = records.length > MAX_PROJECTS;
  records = records.slice(0, MAX_PROJECTS);
  const run = input.run ?? defaultRun;
  const env = safeEnvironment();
  const started = performance.now();
  const matches = new Map<string, string>();
  let remotesRead = 0;
  for (const record of records) {
    if (performance.now() - started >= TOTAL_BUDGET_MS) break;
    const projectPath = record.path.projectRoot ?? record.path.cwd;
    let canonicalProject: string;
    try {
      canonicalProject = await realpath(projectPath);
      const metadata = await lstat(canonicalProject);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    } catch {
      truncated = true;
      continue;
    }
    let repositoryRoot: string;
    try {
      const result = await run(
        "git",
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"],
        {
          cwd: canonicalProject,
          env,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 8 * 1024
        }
      );
      repositoryRoot = await realpath(result.stdout.trim());
    } catch {
      truncated = true;
      continue;
    }
    if (repositoryRoot !== canonicalProject) continue;
    let names: string[];
    try {
      const result = await run(
        "git",
        ["-c", "core.hooksPath=/dev/null", "remote"],
        {
          cwd: repositoryRoot,
          env,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES
        }
      );
      const remoteNames = result.stdout.split(/\r?\n/).filter(Boolean);
      if (remoteNames.length > MAX_REMOTES_PER_PROJECT) truncated = true;
      names = remoteNames.slice(0, MAX_REMOTES_PER_PROJECT);
    } catch {
      truncated = true;
      continue;
    }
    for (const name of names) {
      if (performance.now() - started >= TOTAL_BUDGET_MS) break;
      if (
        remotesRead >= MAX_REMOTES_TOTAL ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name) ||
        Buffer.byteLength(name, "utf8") > MAX_REMOTE_NAME_BYTES
      )
        break;
      remotesRead += 1;
      try {
        const result = await run(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "remote",
            "get-url",
            "--all",
            name
          ],
          {
            cwd: repositoryRoot,
            env,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_COMMAND_OUTPUT_BYTES
          }
        );
        const urls = result.stdout.split(/\r?\n/).filter(Boolean);
        if (urls.length > MAX_REMOTES_PER_PROJECT) truncated = true;
        if (
          urls
            .slice(0, MAX_REMOTES_PER_PROJECT)
            .some((url) => parseGithubRemote(url.trim()) === expectedRepository)
        )
          matches.set(record.localProjectId, record.displayName);
      } catch {
        // An invalid, inaccessible, or timed-out local repo is not a match.
        truncated = true;
      }
    }
  }
  return {
    projects: [...matches]
      .map(([id, displayName]) => ({ id, displayName }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    truncated:
      truncated ||
      performance.now() - started >= TOTAL_BUDGET_MS ||
      remotesRead >= MAX_REMOTES_TOTAL
  };
};
