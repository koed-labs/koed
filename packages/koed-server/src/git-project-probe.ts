import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeGitRemoteUrl, type NormalizedGitRemote } from "@koed/shared";

export interface GitProjectProbeResult {
  status: "git" | "non_git" | "failed" | "ambiguous";
  failedCommands: string[];
  root: string | null;
  remotes: NormalizedGitRemote[];
  branch: string | null;
  headCommit: string | null;
  commonDir: string | null;
  gitDir: string | null;
}

export interface GitProjectProbeInput {
  profile: string;
  cwd: string;
  deviceSalt: string;
  configurationRevision?: string;
}

export interface GitProjectProbeDeps {
  execFile?: typeof execFile;
  statSync?: typeof statSync;
  now?: () => number;
  ttlMs?: number;
}

// The probe observes Git only. The caller owns persisted configuration and salt.
export const createGitProjectProbe = (deps: GitProjectProbeDeps = {}) => {
  const execute = deps.execFile ?? execFile;
  const stat = deps.statSync ?? statSync;
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 2_000;
  const cache = new Map<
    string,
    {
      expiresAt: number;
      signature: string;
      watchedPaths: string[];
      result: GitProjectProbeResult;
    }
  >();
  const signature = (paths: string[]) =>
    JSON.stringify(
      paths.map((file) => {
        try {
          const value = stat(file);
          return [
            file,
            value.dev,
            value.ino,
            value.size,
            value.mtimeMs,
            value.ctimeMs
          ];
        } catch {
          return [file, null];
        }
      })
    );
  const command = (cwd: string, args: string[]) =>
    new Promise<{
      value: string | null;
      failed: boolean;
      nonGit: boolean;
    }>((done) => {
      const finish = (
        error: Error | null,
        stdout: unknown,
        stderr?: unknown
      ) => {
        done({
          value: error ? null : String(stdout).trim() || null,
          failed: Boolean(error),
          nonGit:
            Boolean(error) &&
            /not a git repository/i.test(
              typeof stderr === "string" ? stderr : ""
            )
        });
      };
      try {
        execute(
          "git",
          ["-C", cwd, ...args],
          {
            timeout: 5_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8"
          },
          finish
        );
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error("Git execution failed"),
          ""
        );
      }
    });
  return async (
    input: GitProjectProbeInput
  ): Promise<GitProjectProbeResult> => {
    const cwd = resolve(input.cwd);
    const key = JSON.stringify([
      resolve(input.profile),
      cwd,
      input.deviceSalt,
      input.configurationRevision ?? ""
    ]);
    const cached = cache.get(key);
    if (
      cached &&
      cached.expiresAt > now() &&
      cached.signature === signature(cached.watchedPaths)
    ) {
      return structuredClone(cached.result);
    }
    const result: GitProjectProbeResult = {
      status: "non_git",
      failedCommands: [],
      root: null,
      remotes: [],
      branch: null,
      headCommit: null,
      commonDir: null,
      gitDir: null
    };
    const root = await command(cwd, ["rev-parse", "--show-toplevel"]);
    if (root.failed) {
      result.status = root.nonGit ? "non_git" : "failed";
      if (!root.nonGit) result.failedCommands.push("rev-parse --show-toplevel");
      return result;
    }
    if (!root.value || root.value.includes("\n")) {
      result.status = "ambiguous";
      return result;
    }
    result.root = resolve(root.value);
    result.status = "git";
    const read = async (args: string[]) => {
      const observation = await command(result.root!, args);
      if (observation.failed) {
        result.failedCommands.push(args.join(" "));
        result.status = "failed";
      }
      return observation.value;
    };
    const rawRemotes = await read(["remote", "-v"]);
    const remotes = new Map<string, NormalizedGitRemote>();
    for (const line of rawRemotes?.split("\n") ?? []) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) {
        if (result.failedCommands.length === 0) result.status = "ambiguous";
        continue;
      }
      const [, name, url] = match;
      remotes.set(`${name}\n${url}`, normalizeGitRemoteUrl(url!, name!));
    }
    result.remotes = [...remotes.values()].sort((a, b) =>
      `${a.name}:${a.fingerprint}`.localeCompare(`${b.name}:${b.fingerprint}`)
    );
    result.branch = await read(["branch", "--show-current"]);
    result.headCommit = await read(["rev-parse", "HEAD"]);
    const commonDir = await read(["rev-parse", "--git-common-dir"]);
    const gitDir = await read(["rev-parse", "--git-dir"]);
    result.commonDir = commonDir ? resolve(result.root, commonDir) : null;
    result.gitDir = gitDir ? resolve(result.root, gitDir) : null;
    if (result.status === "git") {
      const watchedPaths = new Set<string>();
      // Watch ancestor markers too: an initialized nested checkout changes the root.
      for (let parent = cwd; ; parent = dirname(parent)) {
        watchedPaths.add(resolve(parent, ".git"));
        if (dirname(parent) === parent) break;
      }
      for (const directory of [result.commonDir, result.gitDir]) {
        if (!directory) continue;
        watchedPaths.add(directory);
        for (const file of [
          "config",
          "config.worktree",
          "HEAD",
          "commondir",
          "packed-refs"
        ]) {
          watchedPaths.add(resolve(directory, file));
        }
        if (result.branch)
          watchedPaths.add(resolve(directory, "refs", "heads", result.branch));
      }
      // Bound memory for long-lived watchers inspecting many checkouts.
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      const paths = [...watchedPaths];
      cache.set(key, {
        result: structuredClone(result),
        watchedPaths: paths,
        signature: signature(paths),
        expiresAt: now() + ttl
      });
    }
    return result;
  };
};

export const probeGitProject = createGitProjectProbe();
