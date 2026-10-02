import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { PullRequestReviewRecord } from "@koed/shared/pull-requests";
import { createGithubDelegatedCli } from "@koed/shared/github-delegated";
import { pullRequestCheckoutKey } from "./pull-request-checkout.js";

const execFile = promisify(nodeExecFile);
const SHA_PATTERN = /^[a-f0-9]{40,64}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,240}$/;
const MAX_CHANGED_FILES = 1_000;
const MAX_PATH_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = MAX_DIFF_BYTES + 64 * 1024;
const FIXED_DATE = "2000-01-01T00:00:00+00:00";

type GitResult = { stdout: string; stderr: string };
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
) => Promise<GitResult>;
type GithubDriver = ReturnType<typeof createGithubDelegatedCli>;
type PrRepo = {
  id: string;
  fullName: string;
  private?: boolean;
  permissions?: { pull?: boolean; push?: boolean; admin?: boolean } | null;
};
type PullRequestShape = {
  pullRequest: {
    number: number;
    state: string;
    draft: boolean;
    merged: boolean;
    author: string;
    baseSha: string;
    headSha: string;
    headBranch: string;
    baseBranch: string;
    baseRepository: PrRepo | null;
    headRepository: PrRepo | null;
  };
};
export type PullRequestPushProposal = {
  proposalVersion: 1;
  reviewId: string;
  executionId: string | null;
  executionGeneration: number | null;
  account: { id: string; login: string };
  connectionGeneration: number;
  repository: { id: string; fullName: string };
  headRepository: { id: string; fullName: string };
  headBranch: string;
  remoteSha: string;
  checkoutHead: string;
  treeSha: string;
  diff: string;
  diffDigest: string;
  commitSha: string;
};

const fail = (code: string) => Object.assign(new Error(code), { name: code });
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const safeRepository = (
  value: string
): { owner: string; name: string; fullName: string } => {
  if (
    typeof value !== "string" ||
    value.length > 401 ||
    !REPOSITORY_PATTERN.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    throw fail("PullRequestRepositoryInvalid");
  const [owner, name] = value.split("/");
  if (!owner || !name) throw fail("PullRequestRepositoryInvalid");
  return { owner, name, fullName: `${owner}/${name}` };
};

const safeBranch = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !BRANCH_PATTERN.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    throw fail("PullRequestBranchInvalid");
  return value;
};

const safeEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR"
  ]) {
    const value = process.env[key];
    if (typeof value === "string") environment[key] = value;
  }
  environment.HOME = homedir();
  environment.GH_PROMPT_DISABLED = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = devNull;
  environment.SSH_ASKPASS = devNull;
  environment.GIT_SSH_COMMAND = "false";
  environment.GIT_ALLOW_PROTOCOL = "https";
  return environment;
};

const gitPrefix = [
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
  "-c",
  `core.askPass=${devNull}`,
  "-c",
  "http.followRedirects=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "commit.gpgSign=false"
];

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

const localConfigKeyAllowed = (key: string) => {
  const normalized = key.toLowerCase();
  return (
    [
      "core.repositoryformatversion",
      "core.filemode",
      "core.bare",
      "core.logallrefupdates",
      "core.ignorecase",
      "core.precomposeunicode",
      "extensions.objectformat"
    ].includes(normalized) ||
    /^remote\.[a-z0-9_.-]+\.(?:url|fetch)$/.test(normalized) ||
    /^branch\.[a-z0-9_.-]+\.(?:remote|merge)$/.test(normalized)
  );
};

const configKeys = async (run: Run, cwd: string) => {
  const { stdout } = await run(
    "git",
    [
      ...gitPrefix,
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--null",
      "--list"
    ],
    {
      cwd,
      env: safeEnvironment(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 128 * 1024
    }
  );
  return stdout.split("\0").filter(Boolean);
};

const validateLocalConfig = async (run: Run, cwd: string) => {
  const keys = await configKeys(run, cwd);
  if (!keys.length || keys.some((key) => !localConfigKeyAllowed(key)))
    throw fail("PullRequestCheckoutConfigUnsafe");
  const remotes = await run("git", [...gitPrefix, "remote"], {
    cwd,
    env: safeEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024
  });
  const names = remotes.stdout.split(/\r?\n/).filter(Boolean);
  if (
    !names.includes("origin") ||
    names.some((name) => !/^[A-Za-z0-9_.-]{1,128}$/.test(name))
  )
    throw fail("PullRequestRepositoryMismatch");
  for (const name of names) {
    const urls = await run(
      "git",
      [...gitPrefix, "remote", "get-url", "--all", name],
      {
        cwd,
        env: safeEnvironment(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024
      }
    );
    for (const url of urls.stdout.split(/\r?\n/).filter(Boolean)) {
      const match =
        /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/i.exec(
          url
        );
      if (!match) throw fail("PullRequestRepositoryMismatch");
      safeRepository(match[1]!);
    }
  }
};

const safeManagedCheckout = async (
  koedHome: string,
  review: PullRequestReviewRecord,
  checkoutPath: string
) => {
  if (!/^[a-f0-9-]{36}$/i.test(review.id))
    throw fail("PullRequestReviewScopeInvalid");
  const repository = safeRepository(review.repository.fullName);
  if (
    !SHA_PATTERN.test(review.expectedHeadSha) ||
    !SHA_PATTERN.test(review.expectedBaseSha)
  )
    throw fail("PullRequestReviewScopeInvalid");
  const home = await realpath(koedHome).catch(() => {
    throw fail("PullRequestCheckoutUnavailable");
  });
  const root = await realpath(
    resolve(home, "managed-pull-requests", "sources")
  ).catch(() => {
    throw fail("PullRequestCheckoutUnavailable");
  });
  const expectedKey = pullRequestCheckoutKey({
    reviewId: review.id,
    repository: repository.fullName,
    baseSha: review.expectedBaseSha,
    headSha: review.expectedHeadSha
  });
  const expectedPath = resolve(root, expectedKey);
  const canonicalCheckout = await realpath(checkoutPath).catch(() => {
    throw fail("PullRequestCheckoutUnavailable");
  });
  const metadata = await lstat(canonicalCheckout).catch(() => null);
  if (
    canonicalCheckout !== expectedPath ||
    !canonicalCheckout.startsWith(`${root}${sep}`) ||
    !metadata?.isDirectory() ||
    metadata.isSymbolicLink()
  )
    throw fail("PullRequestCheckoutUnavailable");
  const gitDirectory = resolve(canonicalCheckout, ".git");
  const gitMetadata = await lstat(gitDirectory).catch(() => null);
  if (!gitMetadata?.isDirectory() || gitMetadata.isSymbolicLink())
    throw fail("PullRequestCheckoutUnavailable");
  return { home, root, checkout: canonicalCheckout, repository };
};

const assertScope = async (
  github: GithubDriver,
  review: PullRequestReviewRecord,
  { allowHeadAdvance = false }: { allowHeadAdvance?: boolean } = {}
) => {
  const repository = safeRepository(review.repository.fullName);
  if (
    !Number.isSafeInteger(review.pullRequestNumber) ||
    review.pullRequestNumber < 1
  )
    throw fail("PullRequestReviewScopeInvalid");
  const identity = await github.readIdentity(review.account.login);
  if (String(identity.id) !== review.account.id)
    throw fail("PullRequestConnectionChanged");
  const baseRepository = await github.readRepository({
    expectedAccountLogin: review.account.login,
    repo: repository.fullName
  });
  if (
    String(baseRepository.id) !== review.repository.id ||
    baseRepository.fullName.toLowerCase() !== repository.fullName.toLowerCase()
  )
    throw fail("PullRequestRepositoryChanged");
  const result = (await github.readPullRequest({
    expectedAccountLogin: review.account.login,
    repo: repository.fullName,
    number: review.pullRequestNumber
  })) as unknown as PullRequestShape;
  const pullRequest = result.pullRequest;
  const baseRepositoryDetail = pullRequest?.baseRepository;
  const headRepository = pullRequest?.headRepository;
  if (
    !pullRequest ||
    !baseRepositoryDetail ||
    !headRepository ||
    String(baseRepositoryDetail.id) !== review.repository.id ||
    baseRepositoryDetail.fullName.toLowerCase() !==
      repository.fullName.toLowerCase() ||
    pullRequest.baseSha.toLowerCase() !==
      review.expectedBaseSha.toLowerCase() ||
    (!allowHeadAdvance &&
      pullRequest.headSha.toLowerCase() !==
        review.expectedHeadSha.toLowerCase()) ||
    pullRequest.state !== "open" ||
    pullRequest.draft ||
    pullRequest.merged
  )
    throw fail("PullRequestReviewOutdated");
  const headName = safeRepository(headRepository.fullName);
  if (headRepository.id !== String(headRepository.id) || !headRepository.id)
    throw fail("PullRequestRepositoryChanged");
  const writableHead = await github.readRepository({
    expectedAccountLogin: review.account.login,
    repo: headName.fullName
  });
  if (
    String(writableHead.id) !== headRepository.id ||
    writableHead.fullName.toLowerCase() !== headName.fullName.toLowerCase() ||
    writableHead.permissions?.push !== true
  )
    throw fail("PullRequestPushUnavailable");
  return {
    identity,
    baseRepository: {
      id: String(baseRepository.id),
      fullName: repository.fullName
    },
    headRepository: {
      id: String(writableHead.id),
      fullName: headName.fullName
    },
    headOwner: headName.owner,
    headName: headName.name,
    headBranch: safeBranch(pullRequest.headBranch),
    remoteSha: pullRequest.headSha,
    pullRequest
  };
};

const assertGitHead = async (run: Run, checkout: string) => {
  const { stdout } = await run("git", [...gitPrefix, "rev-parse", "HEAD"], {
    cwd: checkout,
    env: safeEnvironment(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024
  });
  const head = stdout.trim();
  if (!SHA_PATTERN.test(head)) throw fail("PullRequestCheckoutUnsafe");
  return head;
};

const parseChangedPaths = (status: string) => {
  const entries = status.split("\0").filter(Boolean);
  if (entries.length > MAX_CHANGED_FILES)
    throw fail("PullRequestPushDiffTooLarge");
  const paths: string[] = [];
  let byteCount = 0;
  for (const entry of entries) {
    if (entry.length < 4) throw fail("PullRequestCheckoutUnsafe");
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (
      code.includes("R") ||
      code.includes("C") ||
      code.includes("U") ||
      !/^(?:\?\?|[ MADT][ MADT])$/.test(code) ||
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git"
        )
    )
      throw fail("PullRequestCheckoutUnsafe");
    byteCount += Buffer.byteLength(path, "utf8") + 1;
    if (byteCount > MAX_PATH_BYTES) throw fail("PullRequestPushDiffTooLarge");
    paths.push(path);
  }
  return [...new Set(paths)];
};

const assertSafeChangedPaths = async (checkout: string, paths: string[]) => {
  for (const path of paths) {
    const target = resolve(checkout, ...path.split("/"));
    const rel = relative(checkout, target);
    if (
      !rel ||
      rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      resolve(checkout, rel) !== target
    )
      throw fail("PullRequestCheckoutUnsafe");
    let current = checkout;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      current = resolve(current, parts[index]!);
      const metadata = await lstat(current).catch(() => null);
      if (!metadata) break;
      if (metadata.isSymbolicLink()) throw fail("PullRequestCheckoutUnsafe");
      if (index < parts.length - 1 && !metadata.isDirectory())
        throw fail("PullRequestCheckoutUnsafe");
      if (index === parts.length - 1 && !metadata.isFile())
        throw fail("PullRequestCheckoutUnsafe");
    }
  }
};

const runGit = (
  run: Run,
  checkout: string,
  args: string[],
  options: { index?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
) => {
  const env = { ...safeEnvironment(), ...(options.env ?? {}) };
  if (options.index) env.GIT_INDEX_FILE = options.index;
  return run("git", [...gitPrefix, ...args], {
    cwd: checkout,
    env,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER
  });
};

const makeProposal = async (
  options: { run: Run; github: GithubDriver; koedHome: string },
  review: PullRequestReviewRecord,
  checkoutPath: string,
  executionGeneration: number
): Promise<PullRequestPushProposal> => {
  if (
    !review.executionId ||
    !Number.isSafeInteger(executionGeneration) ||
    executionGeneration < 1
  )
    throw fail("PullRequestExecutionChanged");
  const paths = await safeManagedCheckout(
    options.koedHome,
    review,
    checkoutPath
  );
  await validateLocalConfig(options.run, paths.checkout);
  const observation = await assertScope(options.github, review);
  const origin = await runGit(
    options.run,
    paths.checkout,
    ["remote", "get-url", "origin"],
    { maxBuffer: 8 * 1024 }
  );
  const expectedBaseUrl = `https://github.com/${paths.repository.fullName}.git`;
  if (origin.stdout.trim().toLowerCase() !== expectedBaseUrl.toLowerCase())
    throw fail("PullRequestRepositoryMismatch");
  const checkoutHead = await assertGitHead(options.run, paths.checkout);
  if (checkoutHead.toLowerCase() !== observation.remoteSha.toLowerCase())
    throw fail("PullRequestCheckoutStale");
  const status = await runGit(
    options.run,
    paths.checkout,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none"
    ],
    { maxBuffer: 256 * 1024 }
  );
  const changedPaths = parseChangedPaths(status.stdout);
  if (!changedPaths.length) throw fail("PullRequestPushNoChanges");
  await assertSafeChangedPaths(paths.checkout, changedPaths);
  const gitMetadata = resolve(paths.checkout, ".git");
  const temporaryIndexDirectory = await mkdtemp(
    resolve(gitMetadata, "koed-push-index-")
  );
  const indexPath = resolve(temporaryIndexDirectory, "index");
  try {
    await runGit(options.run, paths.checkout, ["read-tree", checkoutHead], {
      index: indexPath,
      maxBuffer: 8 * 1024
    });
    await runGit(
      options.run,
      paths.checkout,
      ["add", "--all", "--", ...changedPaths],
      {
        index: indexPath,
        maxBuffer: 128 * 1024
      }
    );
    const treeResult = await runGit(
      options.run,
      paths.checkout,
      ["write-tree"],
      {
        index: indexPath,
        maxBuffer: 8 * 1024
      }
    );
    const treeSha = treeResult.stdout.trim();
    if (!SHA_PATTERN.test(treeSha)) throw fail("PullRequestCheckoutUnsafe");
    const diffResult = await runGit(
      options.run,
      paths.checkout,
      [
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-renames",
        "--full-index",
        checkoutHead
      ],
      { index: indexPath, maxBuffer: MAX_DIFF_BYTES }
    );
    const diff = diffResult.stdout;
    if (!diff || Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES)
      throw fail("PullRequestPushDiffTooLarge");
    const diffDigest = hash(diff);
    const message = `Koed reviewed change ${review.id}\n\nDiff-SHA256: ${diffDigest}`;
    const commitResult = await runGit(
      options.run,
      paths.checkout,
      [
        "-c",
        "user.name=Koed Studio",
        "-c",
        "user.email=koed-studio@localhost",
        "commit-tree",
        treeSha,
        "-p",
        checkoutHead,
        "-m",
        message
      ],
      {
        index: indexPath,
        maxBuffer: 8 * 1024,
        env: {
          GIT_AUTHOR_NAME: "Koed Studio",
          GIT_AUTHOR_EMAIL: "koed-studio@localhost",
          GIT_AUTHOR_DATE: FIXED_DATE,
          GIT_COMMITTER_NAME: "Koed Studio",
          GIT_COMMITTER_EMAIL: "koed-studio@localhost",
          GIT_COMMITTER_DATE: FIXED_DATE
        }
      }
    );
    const commitSha = commitResult.stdout.trim();
    if (!SHA_PATTERN.test(commitSha)) throw fail("PullRequestCheckoutUnsafe");
    const parent = await runGit(
      options.run,
      paths.checkout,
      ["rev-list", "--parents", "-n", "1", commitSha],
      { maxBuffer: 8 * 1024 }
    );
    if (
      parent.stdout.trim().toLowerCase() !==
      `${commitSha} ${checkoutHead}`.toLowerCase()
    )
      throw fail("PullRequestCheckoutUnsafe");
    await runGit(
      options.run,
      paths.checkout,
      ["check-ref-format", `refs/heads/${observation.headBranch}`],
      { maxBuffer: 8 * 1024 }
    );
    const finalObservation = await assertScope(options.github, review);
    if (
      finalObservation.remoteSha.toLowerCase() !==
        observation.remoteSha.toLowerCase() ||
      finalObservation.headBranch !== observation.headBranch ||
      finalObservation.headRepository.id !== observation.headRepository.id
    )
      throw fail("PullRequestReviewOutdated");
    return {
      proposalVersion: 1,
      reviewId: review.id,
      executionId: review.executionId,
      executionGeneration,
      account: { id: review.account.id, login: review.account.login },
      connectionGeneration: review.connectionGeneration,
      repository: {
        id: review.repository.id,
        fullName: paths.repository.fullName
      },
      headRepository: observation.headRepository,
      headBranch: observation.headBranch,
      remoteSha: observation.remoteSha,
      checkoutHead,
      treeSha,
      diff,
      diffDigest,
      commitSha
    };
  } finally {
    await rm(temporaryIndexDirectory, { recursive: true, force: true });
  }
};

const validateProposal = (value: unknown): PullRequestPushProposal => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("PullRequestPushProposalInvalid");
  const proposal = value as Record<string, unknown>;
  const keys = [
    "proposalVersion",
    "reviewId",
    "executionId",
    "executionGeneration",
    "account",
    "connectionGeneration",
    "repository",
    "headRepository",
    "headBranch",
    "remoteSha",
    "checkoutHead",
    "treeSha",
    "diff",
    "diffDigest",
    "commitSha"
  ];
  if (
    Object.keys(proposal).sort().join("\0") !== [...keys].sort().join("\0") ||
    proposal.proposalVersion !== 1 ||
    typeof proposal.reviewId !== "string" ||
    (proposal.executionId !== null &&
      typeof proposal.executionId !== "string") ||
    (proposal.executionGeneration !== null &&
      (!Number.isSafeInteger(proposal.executionGeneration) ||
        Number(proposal.executionGeneration) < 1)) ||
    !Number.isSafeInteger(proposal.connectionGeneration) ||
    Number(proposal.connectionGeneration) < 1 ||
    typeof proposal.headBranch !== "string" ||
    typeof proposal.diff !== "string" ||
    Buffer.byteLength(proposal.diff, "utf8") > MAX_DIFF_BYTES ||
    typeof proposal.diffDigest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(proposal.diffDigest) ||
    hash(proposal.diff) !== proposal.diffDigest
  )
    throw fail("PullRequestPushProposalInvalid");
  for (const shaKey of [
    "remoteSha",
    "checkoutHead",
    "treeSha",
    "commitSha"
  ] as const) {
    if (
      typeof proposal[shaKey] !== "string" ||
      !SHA_PATTERN.test(proposal[shaKey] as string)
    )
      throw fail("PullRequestPushProposalInvalid");
  }
  const account = proposal.account as Record<string, unknown> | null;
  const repository = proposal.repository as Record<string, unknown> | null;
  const headRepository = proposal.headRepository as Record<
    string,
    unknown
  > | null;
  if (
    !account ||
    typeof account.id !== "string" ||
    typeof account.login !== "string" ||
    !repository ||
    typeof repository.id !== "string" ||
    typeof repository.fullName !== "string" ||
    !headRepository ||
    typeof headRepository.id !== "string" ||
    typeof headRepository.fullName !== "string"
  )
    throw fail("PullRequestPushProposalInvalid");
  safeRepository(repository.fullName);
  safeRepository(headRepository.fullName);
  safeBranch(proposal.headBranch);
  return value as PullRequestPushProposal;
};

const proposalMatchesReview = (
  proposal: PullRequestPushProposal,
  review: PullRequestReviewRecord
) =>
  proposal.reviewId === review.id &&
  proposal.account.id === review.account.id &&
  proposal.account.login.toLowerCase() === review.account.login.toLowerCase() &&
  proposal.connectionGeneration === review.connectionGeneration &&
  proposal.repository.id === review.repository.id &&
  proposal.repository.fullName.toLowerCase() ===
    review.repository.fullName.toLowerCase() &&
  proposal.remoteSha.toLowerCase() === review.expectedHeadSha.toLowerCase() &&
  proposal.executionId === review.executionId &&
  Number.isSafeInteger(proposal.executionGeneration) &&
  Number(proposal.executionGeneration) > 0;

export const createPullRequestPushDriver = (options: {
  koedHome: string;
  github?: GithubDriver;
  run?: Run;
}) => {
  const github = options.github ?? createGithubDelegatedCli();
  const run = options.run ?? defaultRun;

  const preparePush = (
    review: PullRequestReviewRecord,
    checkoutPath: string,
    executionGeneration: number
  ) =>
    makeProposal(
      { run, github, koedHome: options.koedHome },
      review,
      checkoutPath,
      executionGeneration
    );

  const push = async (
    review: PullRequestReviewRecord,
    value: unknown,
    checkoutPath: string,
    executionGeneration: number,
    assertDispatchAllowed: () => Promise<void>
  ) => {
    const proposal = validateProposal(value);
    if (!proposalMatchesReview(proposal, review))
      throw fail("PullRequestPushProposalChanged");
    const current = await preparePush(
      review,
      checkoutPath,
      executionGeneration
    );
    if (JSON.stringify(current) !== JSON.stringify(proposal))
      throw fail("PullRequestPushProposalChanged");
    const paths = await safeManagedCheckout(
      options.koedHome,
      review,
      checkoutPath
    );
    const ancestor = await runGit(
      run,
      paths.checkout,
      ["merge-base", "--is-ancestor", proposal.remoteSha, proposal.commitSha],
      { maxBuffer: 8 * 1024 }
    ).catch(() => {
      throw fail("PullRequestPushNotFastForward");
    });
    void ancestor;
    const branchRef = `refs/heads/${proposal.headBranch}`;
    const remoteUrl = `https://github.com/${safeRepository(proposal.headRepository.fullName).fullName}.git`;
    const refspec = `${proposal.commitSha}:${branchRef}`;
    if (typeof assertDispatchAllowed !== "function")
      throw fail("PullRequestConnectionChanged");
    await assertDispatchAllowed();
    try {
      await runGit(
        run,
        paths.checkout,
        [
          "push",
          "--porcelain",
          "--no-verify",
          `--force-with-lease=${branchRef}:${proposal.remoteSha}`,
          remoteUrl,
          refspec
        ],
        { maxBuffer: 32 * 1024 }
      );
    } catch {
      throw fail("PullRequestPushUncertain");
    }
    try {
      const after = await assertScope(github, review, {
        allowHeadAdvance: true
      });
      if (
        after.headRepository.id !== proposal.headRepository.id ||
        after.headRepository.fullName.toLowerCase() !==
          proposal.headRepository.fullName.toLowerCase() ||
        after.headBranch !== proposal.headBranch ||
        after.remoteSha.toLowerCase() !== proposal.commitSha.toLowerCase()
      )
        throw fail("PullRequestPushUncertain");
    } catch {
      throw fail("PullRequestPushUncertain");
    }
    return {
      pushed: true,
      reviewId: review.id,
      commitSha: proposal.commitSha,
      remoteHeadSha: proposal.commitSha,
      headRepository: proposal.headRepository,
      headBranch: proposal.headBranch,
      diffDigest: proposal.diffDigest
    };
  };

  const reconcilePush = async (
    review: PullRequestReviewRecord,
    value: unknown,
    _checkoutPath: string
  ) => {
    const proposal = validateProposal(value);
    // Outcome reads remain available after a fresh review or reauthorization.
    // The runner binds this stored proposal to its original uncertain operation;
    // only writes require its old revision and connection generation to match.
    if (
      proposal.reviewId !== review.id ||
      proposal.account.id !== review.account.id ||
      proposal.account.login.toLowerCase() !==
        review.account.login.toLowerCase() ||
      proposal.repository.id !== review.repository.id ||
      proposal.repository.fullName.toLowerCase() !==
        review.repository.fullName.toLowerCase()
    )
      throw fail("PullRequestPushProposalChanged");
    void _checkoutPath;
    let remoteHeadSha: string | null = null;
    let confirmed: boolean;
    try {
      const observation = await assertScope(github, review, {
        allowHeadAdvance: true
      });
      remoteHeadSha = observation.remoteSha;
      confirmed =
        observation.headRepository.id === proposal.headRepository.id &&
        observation.headRepository.fullName.toLowerCase() ===
          proposal.headRepository.fullName.toLowerCase() &&
        observation.headBranch === proposal.headBranch &&
        observation.remoteSha.toLowerCase() ===
          proposal.commitSha.toLowerCase();
    } catch {
      confirmed = false;
    }
    return {
      confirmed,
      proposedCommitSha: proposal.commitSha,
      remoteHeadSha,
      diffDigest: proposal.diffDigest
    };
  };

  return Object.freeze({ preparePush, push, reconcilePush });
};

export const pullRequestPushLimits = Object.freeze({
  maxChangedFiles: MAX_CHANGED_FILES,
  maxPathBytes: MAX_PATH_BYTES,
  maxDiffBytes: MAX_DIFF_BYTES,
  timeoutMs: GIT_TIMEOUT_MS,
  maxBuffer: GIT_MAX_BUFFER
});
