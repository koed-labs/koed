import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const sha = /^[a-f0-9]{40,64}$/i;
const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export type PullRequestCheckoutScope = {
  reviewId: string;
  repository: string;
  number: number;
  accountLogin: string;
  baseSha: string;
  headSha: string;
};
export type PullRequestCheckoutObservation = {
  accountLogin: string;
  repository: string;
  baseSha: string;
  headSha: string;
};
export const pullRequestCheckoutKey = (scope: {
  reviewId: string;
  repository: string;
  headSha: string;
  baseSha: string;
}) =>
  createHash("sha256")
    .update(
      `${scope.reviewId}:${scope.repository}:${scope.baseSha}:${scope.headSha}`
    )
    .digest("hex");
const error = (code: string) => Object.assign(new Error(code), { name: code });
export const pullRequestProcessEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "SYSTEMROOT"
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null"
  };
};
export const preparePullRequestCheckout = async (input: {
  koedHome: string;
  scope: PullRequestCheckoutScope;
  observe: () => Promise<PullRequestCheckoutObservation>;
  run?: (
    binary: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeout: number;
      maxBuffer: number;
    }
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<string> => {
  const scope = input.scope;
  if (
    !/^[a-f0-9-]{36}$/i.test(scope.reviewId) ||
    !repo.test(scope.repository) ||
    scope.repository.split("/").some((x) => x === "." || x === "..") ||
    !Number.isSafeInteger(scope.number) ||
    scope.number < 1 ||
    !sha.test(scope.headSha) ||
    !sha.test(scope.baseSha)
  )
    throw error("PullRequestScopeInvalid");
  const assertCurrent = async () => {
    const observed = await input.observe();
    if (
      observed.accountLogin.toLowerCase() !==
        scope.accountLogin.toLowerCase() ||
      observed.repository.toLowerCase() !== scope.repository.toLowerCase() ||
      observed.headSha !== scope.headSha ||
      observed.baseSha !== scope.baseSha
    )
      throw error("PullRequestScopeStale");
  };
  await assertCurrent();
  const root = resolve(input.koedHome, "managed-pull-requests", "sources");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw error("PullRequestCheckoutRootInvalid");
  const canonicalRoot = await realpath(root);
  const canonicalHome = await realpath(input.koedHome);
  if (!canonicalRoot.startsWith(`${canonicalHome}${sep}`))
    throw error("PullRequestCheckoutRootInvalid");
  const key = pullRequestCheckoutKey(scope);
  const path = resolve(canonicalRoot, key);
  if (!path.startsWith(`${canonicalRoot}${sep}`))
    throw error("PullRequestCheckoutRootInvalid");
  const run = input.run ?? execFile;
  const options = {
    cwd: canonicalRoot,
    env: pullRequestProcessEnvironment(),
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024
  };
  const exists = await lstat(path).catch(() => null);
  if (!exists) {
    const temporary = resolve(canonicalRoot, `${key}.${randomUUID()}.tmp`);
    try {
      // Publish the managed directory only after checkout succeeds. A crashed
      // clone never poisons the stable checkout used for subsequent attempts.
      await run(
        "gh",
        [
          "repo",
          "clone",
          `https://github.com/${scope.repository}.git`,
          temporary,
          "--",
          "--no-checkout",
          "--filter=blob:none"
        ],
        options
      );
      await run(
        "gh",
        [
          "pr",
          "checkout",
          String(scope.number),
          "--repo",
          scope.repository,
          "--detach"
        ],
        { ...options, cwd: temporary }
      );
      await run(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "fetch",
          "origin",
          scope.baseSha,
          scope.headSha
        ],
        { ...options, cwd: temporary }
      );
      const ready = await run(
        "git",
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"],
        { ...options, cwd: temporary }
      );
      if (ready.stdout.trim() !== scope.headSha)
        throw error("PullRequestScopeStale");
      await rename(temporary, path);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else if (!exists.isDirectory() || exists.isSymbolicLink())
    throw error("PullRequestCheckoutRootInvalid");
  if ((await realpath(path)) !== path)
    throw error("PullRequestCheckoutRootInvalid");
  const head = await run(
    "git",
    ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"],
    { ...options, cwd: path }
  );
  if (head.stdout.trim() !== scope.headSha)
    throw error("PullRequestScopeStale");
  await run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "cat-file",
      "-e",
      `${scope.baseSha}^{commit}`
    ],
    { ...options, cwd: path }
  );
  const remote = await run("git", ["remote", "get-url", "origin"], {
    ...options,
    cwd: path
  });
  if (
    remote.stdout.trim().toLowerCase() !==
    `https://github.com/${scope.repository}.git`.toLowerCase()
  )
    throw error("PullRequestRepositoryMismatch");
  await assertCurrent();
  return path;
};
