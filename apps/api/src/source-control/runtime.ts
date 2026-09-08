import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ManagedTerminalExecutionAuthority,
  MemorySourceRepository
} from "@koed/db";
import {
  sourceControlConnectionSchema,
  sourceControlOperationSchema,
  sourceControlRemoteSchema,
  sourceControlResultSchema,
  type SourceControlConnection,
  type SourceControlCapability,
  type SourceControlOperation,
  type SourceControlProvider,
  type SourceControlRemote,
  type SourceControlResult
} from "@koed/shared";
import { createGitExecutionCheckoutDriver } from "@koed/shared/execution-checkout";
import { z } from "zod";

import { withAuthenticatedGitRepository } from "./authenticated-git.js";

import { resolveCommandSecret } from "../secrets/command-secret-provider.js";
import {
  sourceControlProviderDriver,
  type SourceControlCredential,
  type SourceControlProviderRepository
} from "./provider-drivers.js";

const execFileAsync = promisify(execFile);
const objectIdPattern = /^[a-f0-9]{40,64}$/i;

const connectionsFileSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(sourceControlConnectionSchema).max(64)
  })
  .strict();

type JournalEntry = {
  digest: string;
  state: "dispatching" | "completed";
  result?: SourceControlResult;
};
const journalSchema = z
  .object({
    version: z.literal(1),
    operations: z.record(
      z.string(),
      z
        .object({
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          state: z.enum(["dispatching", "completed"]),
          result: sourceControlResultSchema.optional()
        })
        .strict()
    )
  })
  .strict();

export interface SourceControlRuntime {
  execute(ownerUserId: string, value: unknown): Promise<SourceControlResult>;
}

const sourceControlError = (
  message: string,
  statusCode: number,
  code: string
) => Object.assign(new Error(message), { statusCode, code });

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const safeRemoteUrl = (
  raw: string
): { host: string; path: string; transport: "https" | "ssh" } | null => {
  const value = raw.trim();
  if (!value || /[\r\n\0]/.test(value)) return null;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        (url.username && url.protocol === "https:") ||
        url.password ||
        url.port ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      return {
        host: url.hostname.toLowerCase(),
        path: url.pathname.replace(/^\/+|\/+$/g, ""),
        transport: url.protocol === "https:" ? "https" : "ssh"
      };
    } catch {
      return null;
    }
  }
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^\s]+)$/.exec(value);
  return scp
    ? {
        host: scp[1]!.toLowerCase(),
        path: scp[2]!.replace(/^\/+|\/+$/g, ""),
        transport: "ssh"
      }
    : null;
};

const providerForHost = (host: string): SourceControlProvider | null => {
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  if (
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host.endsWith(".visualstudio.com")
  ) {
    return "azure_devops";
  }
  return null;
};

const requiredCapability = (
  operation: Exclude<SourceControlOperation, { kind: "remotes" }>
): SourceControlCapability => {
  switch (operation.kind) {
    case "inspect":
      return "repository_read";
    case "branches":
      return "branch_read";
    case "fetch":
    case "fast_forward":
      return "fetch";
    case "push":
      return "push";
    case "review_requests":
    case "review_request":
      return "review_request_read";
    case "review_request_create":
      return "review_request_create";
    case "checks":
      return "checks_read";
    case "comments":
      return "comments_read";
    case "comment_create":
      return "comments_write";
    case "review_create":
      return "reviews_write";
  }
};

const locatorFor = (
  provider: SourceControlProvider,
  host: string,
  rawPath: string
): SourceControlProviderRepository | null => {
  const path = rawPath.replace(/\.git$/i, "");
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (provider === "azure_devops") {
    if (host === "ssh.dev.azure.com") {
      if (segments.length !== 4 || segments[0] !== "v3") return null;
      return {
        namespace: segments[1]!,
        project: segments[2]!,
        repository: segments[3]!
      };
    }
    if (host === "dev.azure.com") {
      const marker = segments.indexOf("_git");
      if (marker !== 2 || !segments[0] || !segments[1] || !segments[3]) {
        return null;
      }
      return {
        namespace: segments[0],
        project: segments[1],
        repository: segments[3]
      };
    }
    const marker = segments.indexOf("_git");
    if (marker !== 1 || !segments[0] || !segments[2]) return null;
    return {
      namespace: host.slice(0, -".visualstudio.com".length),
      project: segments[0],
      repository: segments[2]
    };
  }
  if (segments.length < 2) return null;
  return {
    namespace: segments.slice(0, -1).join("/"),
    repository: segments.at(-1)!,
    project: null
  };
};

const checkoutFor = (
  binding: NonNullable<
    Awaited<
      ReturnType<MemorySourceRepository["getManagedConversationRuntimeBinding"]>
    >
  >
) => ({
  checkoutId: binding.checkoutId!,
  vcsDriver: binding.vcsDriver,
  ownership:
    binding.checkoutKind === "pending"
      ? ("non_vcs_directory" as const)
      : binding.checkoutKind,
  canonicalPath: binding.projectPath,
  localRepositoryCommonDirectory: binding.localRepositoryCommonDirectory,
  localGitDirectory: binding.localGitDirectory,
  repositoryIdentityHash: binding.repositoryIdentityHash,
  worktreeIdentityHash: binding.worktreeIdentityHash,
  baseRef: binding.baseRef,
  baseObjectId: binding.baseObjectId,
  branchRef: binding.branchRef,
  headObjectId: binding.headObjectId
});

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0"
});

const git = async (
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  stdin?: string
): Promise<string> => {
  const running = execFileAsync("git", args, {
    cwd,
    env: { ...gitEnvironment(), ...environment },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  running.child.stdin?.end(stdin);
  return (await running).stdout.trim();
};

const credentialSchema = z.discriminatedUnion("scheme", [
  z
    .object({
      scheme: z.literal("bearer"),
      token: z.string().min(1).max(16_384)
    })
    .strict(),
  z
    .object({
      scheme: z.literal("basic"),
      username: z.string().max(512),
      token: z.string().min(1).max(16_384)
    })
    .strict()
]);

const readPrivateJson = async (path: string): Promise<unknown> => {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata) return null;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw sourceControlError(
      "Source-control metadata storage is unsafe",
      503,
      "source_control_storage_unsafe"
    );
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
};

export const createSourceControlRuntime = (options: {
  koedHome: string;
  requireRepository(): MemorySourceRepository;
  fetch: typeof fetch;
  resolveCredential?: (reference: string) => Promise<string | null>;
  assertExecutionAuthority(
    ownerUserId: string,
    executionId: string
  ): Promise<ManagedTerminalExecutionAuthority>;
}): SourceControlRuntime => {
  const connectionsPath = resolve(
    options.koedHome,
    "config",
    "source-control-connections.json"
  );
  const journalPath = resolve(
    options.koedHome,
    "state",
    "source-control-operations.json"
  );
  let checkoutDriver: ReturnType<
    typeof createGitExecutionCheckoutDriver
  > | null = null;
  const requireCheckoutDriver = () =>
    (checkoutDriver ??= createGitExecutionCheckoutDriver({
      managedRoot: resolve(options.koedHome, "managed-checkouts", "worktrees")
    }));
  let journalSerial = Promise.resolve();

  const connections = async (): Promise<SourceControlConnection[]> => {
    const value = await readPrivateJson(connectionsPath);
    return value === null ? [] : connectionsFileSchema.parse(value).connections;
  };

  const readJournal = async (): Promise<Record<string, JournalEntry>> => {
    const value = await readPrivateJson(journalPath);
    return value === null ? {} : journalSchema.parse(value).operations;
  };
  const writeJournal = async (
    operations: Record<string, JournalEntry>
  ): Promise<void> => {
    await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, operations })}\n`,
      { mode: 0o600 }
    );
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, journalPath);
  };
  const journal = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = journalSerial.then(operation, operation);
    journalSerial = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  };

  const executionContext = async (
    ownerUserId: string,
    operation: SourceControlOperation
  ) => {
    const repository = options.requireRepository();
    const [execution, binding] = await Promise.all([
      options.assertExecutionAuthority(ownerUserId, operation.executionId),
      repository.getManagedConversationRuntimeBinding(
        { userId: ownerUserId },
        operation.executionId
      )
    ]);
    if (
      !execution ||
      !binding ||
      execution.executionGeneration !== operation.executionGeneration ||
      binding.executionGeneration !== operation.executionGeneration ||
      binding.checkoutLifecycle !== "ready" ||
      binding.vcsDriver !== "git" ||
      !binding.checkoutId
    ) {
      throw sourceControlError(
        "Source-control checkout authority is stale",
        409,
        "source_control_checkout_stale"
      );
    }
    await (await requireCheckoutDriver()).verify(checkoutFor(binding));
    const headObjectId = await git(binding.projectPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}"
    ]);
    if (!objectIdPattern.test(headObjectId)) {
      throw sourceControlError(
        "Source-control checkout revision is unavailable",
        409,
        "source_control_revision_unavailable"
      );
    }
    return { binding, headObjectId };
  };

  const remotesFor = async (
    cwd: string
  ): Promise<
    Array<
      SourceControlRemote & {
        repository: SourceControlProviderRepository;
        transportUrl: string;
      }
    >
  > => {
    const names = (await git(cwd, ["remote"]))
      .split("\n")
      .filter(Boolean)
      .slice(0, 32);
    const configured = await connections();
    const values = await Promise.all(
      names.map(async (remoteName) => {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(remoteName)) return null;
        const raw = await git(cwd, [
          "config",
          "--local",
          "--get",
          `remote.${remoteName}.url`
        ]).catch(() => "");
        const normalized = safeRemoteUrl(raw);
        if (!normalized) return null;
        const configuredForHost = configured.filter(
          (connection) =>
            connection.host ===
            (normalized.host === "ssh.dev.azure.com"
              ? "dev.azure.com"
              : normalized.host)
        );
        const configuredProviders = [
          ...new Set(configuredForHost.map((connection) => connection.provider))
        ];
        const provider =
          configuredProviders.length === 1
            ? configuredProviders[0]!
            : configuredProviders.length === 0
              ? providerForHost(normalized.host)
              : null;
        if (!provider) return null;
        const repository = locatorFor(
          provider,
          normalized.host,
          normalized.path
        );
        if (!repository) return null;
        const matches = configuredForHost.filter(
          (connection) => connection.provider === provider
        );
        const connection = matches.length === 1 ? matches[0]! : null;
        const connected = connection?.state === "active";
        const remoteIdentityHash = sha256(
          JSON.stringify({
            remoteName,
            provider,
            host: normalized.host,
            transport: normalized.transport,
            repository
          })
        );
        return {
          ...sourceControlRemoteSchema.parse({
            remoteName,
            provider,
            host: normalized.host,
            transport: normalized.transport,
            locator: repository,
            remoteIdentityHash,
            connectionId: connected ? connection.id : null,
            credentialGeneration: connected
              ? connection.credentialGeneration
              : null,
            connectionState:
              matches.length > 1
                ? "unavailable"
                : connection?.state === "revoked"
                  ? "revoked"
                  : connected
                    ? "connected"
                    : "connection_required",
            capabilities: connected ? connection.capabilities : []
          }),
          repository,
          transportUrl: raw
        };
      })
    );
    return values.filter((value) => value !== null);
  };
  const publicRemote = (
    value: SourceControlRemote & {
      repository: SourceControlProviderRepository;
    }
  ): SourceControlRemote => {
    const remote: Record<string, unknown> = { ...value };
    delete remote.repository;
    delete remote.transportUrl;
    return sourceControlRemoteSchema.parse(remote);
  };

  const credentialFor = async (
    connection: SourceControlConnection
  ): Promise<SourceControlCredential> => {
    const raw = await (
      options.resolveCredential ??
      ((reference) => resolveCommandSecret(reference))
    )(connection.credentialReference);
    if (!raw) {
      throw sourceControlError(
        "Source-control credential is unavailable",
        503,
        "source_control_credential_unavailable"
      );
    }
    try {
      return credentialSchema.parse(JSON.parse(raw));
    } catch {
      throw sourceControlError(
        "Source-control credential is invalid",
        503,
        "source_control_credential_invalid"
      );
    }
  };

  const executeBound = async (
    ownerUserId: string,
    operation: Exclude<SourceControlOperation, { kind: "remotes" }>,
    markDispatching?: () => Promise<void>
  ): Promise<SourceControlResult> => {
    const { binding, headObjectId } = await executionContext(
      ownerUserId,
      operation
    );
    const remotes = await remotesFor(binding.projectPath);
    const selected = remotes.find(
      (remote) => remote.remoteIdentityHash === operation.remoteIdentityHash
    );
    if (!selected || !selected.connectionId) {
      throw sourceControlError(
        "Source-control remote connection is unavailable",
        409,
        "source_control_connection_required"
      );
    }
    const connection = (await connections()).find(
      (item) => item.id === selected.connectionId && item.state === "active"
    );
    if (!connection) {
      throw sourceControlError(
        "Source-control connection was revoked",
        403,
        "source_control_connection_revoked"
      );
    }
    if (
      "credentialGeneration" in operation &&
      operation.credentialGeneration !== connection.credentialGeneration
    ) {
      throw sourceControlError(
        "Source-control credential generation is stale",
        409,
        "source_control_credential_stale"
      );
    }
    const capability = requiredCapability(operation);
    if (!connection.capabilities.includes(capability)) {
      throw sourceControlError(
        `Source-control connection does not grant ${capability}`,
        403,
        "source_control_capability_denied"
      );
    }
    const credential = await credentialFor(connection);
    const driver = sourceControlProviderDriver(selected.provider);
    const providerInput = {
      connection,
      credential,
      repository: selected.repository,
      fetch: options.fetch
    };
    const validateBranch = async (branch: string): Promise<void> => {
      await git(binding.projectPath, [
        "check-ref-format",
        "--branch",
        branch
      ]).catch(() => {
        throw sourceControlError(
          "Source-control branch name is invalid",
          400,
          "source_control_branch_invalid"
        );
      });
    };
    if (operation.kind === "inspect") {
      const inspected = await driver.inspect(providerInput);
      const currentBranch = await git(binding.projectPath, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD"
      ]).catch(() => null);
      return sourceControlResultSchema.parse({
        kind: "inspect",
        remote: publicRemote(selected),
        defaultBranch: inspected.defaultBranch,
        defaultBranchObjectId: inspected.headObjectId,
        currentBranch,
        headObjectId
      });
    }
    if (operation.kind === "branches") {
      const page = await driver.branches({
        ...providerInput,
        cursor: operation.cursor
      });
      return sourceControlResultSchema.parse({
        kind: "branches",
        branches: page.items,
        nextCursor: page.nextCursor
      });
    }
    if (operation.kind === "review_requests") {
      const page = await driver.reviewRequests({
        ...providerInput,
        state: operation.state,
        cursor: operation.cursor
      });
      return sourceControlResultSchema.parse({
        kind: "review_requests",
        reviewRequests: page.items,
        nextCursor: page.nextCursor
      });
    }
    if (operation.kind === "review_request") {
      return sourceControlResultSchema.parse({
        kind: "review_request",
        reviewRequest: await driver.reviewRequest({
          ...providerInput,
          number: operation.number
        })
      });
    }
    if (operation.kind === "checks") {
      return sourceControlResultSchema.parse({
        kind: "checks",
        checks: await driver.checks({
          ...providerInput,
          objectId: operation.objectId
        })
      });
    }
    if (operation.kind === "comments") {
      const page = await driver.comments({
        ...providerInput,
        number: operation.number,
        cursor: operation.cursor
      });
      return sourceControlResultSchema.parse({
        kind: "comments",
        comments: page.items,
        nextCursor: page.nextCursor
      });
    }
    if (
      ["fetch", "push", "fast_forward", "review_request_create"].includes(
        operation.kind
      ) &&
      operation.expectedHeadObjectId !== headObjectId
    ) {
      throw sourceControlError(
        "Source-control operation revision is stale",
        409,
        "source_control_revision_stale"
      );
    }
    if (operation.kind === "fetch") {
      if (operation.remoteName !== selected.remoteName) {
        throw sourceControlError(
          "Source-control remote binding changed",
          409,
          "source_control_remote_stale"
        );
      }
      if (selected.transport !== "https") {
        throw sourceControlError(
          "SSH source-control operations require an explicit SSH-agent binding",
          409,
          "source_control_ssh_binding_required"
        );
      }
      await markDispatching?.();
      const prefix = `refs/remotes/${selected.remoteName}/`;
      const before = await git(binding.projectPath, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        prefix
      ]);
      const fetched = await withAuthenticatedGitRepository(
        {
          credential,
          commonDirectory: binding.localRepositoryCommonDirectory!,
          objectFormat: headObjectId.length === 64 ? "sha256" : "sha1"
        },
        async (run) => {
          await run([
            "fetch",
            "--no-tags",
            "--",
            selected.transportUrl,
            "+refs/heads/*:refs/heads/*"
          ]);
          return run([
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/"
          ]);
        }
      );
      const oldRefs = new Map(
        before
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ") as [string, string])
      );
      const newRefs = new Map(
        fetched
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [ref, objectId] = line.split(" ");
            return [
              prefix + ref!.slice("refs/heads/".length),
              objectId!
            ] as const;
          })
      );
      // One transaction keeps tracking refs consistent if a concurrent update conflicts.
      const updates = ["start"];
      for (const [ref, objectId] of newRefs) {
        updates.push(
          `update ${ref} ${objectId} ${oldRefs.get(ref) ?? "0".repeat(headObjectId.length)}`
        );
      }
      for (const [ref, objectId] of oldRefs) {
        if (!newRefs.has(ref)) updates.push(`delete ${ref} ${objectId}`);
      }
      updates.push("prepare", "commit", "");
      await git(
        binding.projectPath,
        ["update-ref", "--stdin"],
        {},
        updates.join("\n")
      );
      return sourceControlResultSchema.parse({
        kind: "fetch",
        operationId: randomUUID(),
        status: "completed",
        headObjectId: await git(binding.projectPath, [
          "rev-parse",
          "HEAD^{commit}"
        ])
      });
    }
    if (operation.kind === "push") {
      if (operation.remoteName !== selected.remoteName) {
        throw sourceControlError(
          "Source-control remote binding changed",
          409,
          "source_control_remote_stale"
        );
      }
      if (selected.transport !== "https") {
        throw sourceControlError(
          "SSH source-control operations require an explicit SSH-agent binding",
          409,
          "source_control_ssh_binding_required"
        );
      }
      await validateBranch(operation.targetBranch);
      const targetRef = `refs/heads/${operation.targetBranch}`;
      await withAuthenticatedGitRepository(
        {
          credential,
          commonDirectory: binding.localRepositoryCommonDirectory!,
          objectFormat: headObjectId.length === 64 ? "sha256" : "sha1"
        },
        async (run) => {
          const advertised = await run([
            "ls-remote",
            "--refs",
            "--",
            selected.transportUrl,
            targetRef
          ]);
          const current = advertised.split(/\s+/u)[0] || null;
          if (current !== operation.expectedRemoteObjectId) {
            throw sourceControlError(
              "Source-control remote revision is stale",
              409,
              "source_control_remote_revision_stale"
            );
          }
          if (current) {
            await run([
              "fetch",
              "--no-tags",
              "--",
              selected.transportUrl,
              targetRef
            ]);
            await run([
              "merge-base",
              "--is-ancestor",
              current,
              headObjectId
            ]).catch(() => {
              throw sourceControlError(
                "Source-control push must be a fast-forward",
                409,
                "source_control_non_fast_forward"
              );
            });
          }
          await markDispatching?.();
          await run([
            "push",
            "--porcelain",
            `--force-with-lease=${targetRef}:${current ?? ""}`,
            "--",
            selected.transportUrl,
            `${headObjectId}:${targetRef}`
          ]);
        }
      );
      return sourceControlResultSchema.parse({
        kind: "push",
        operationId: randomUUID(),
        status: "completed",
        headObjectId
      });
    }
    if (operation.kind === "fast_forward") {
      if (operation.remoteName !== selected.remoteName) {
        throw sourceControlError(
          "Source-control remote binding changed",
          409,
          "source_control_remote_stale"
        );
      }
      await validateBranch(operation.remoteBranch);
      const remoteRef = `refs/remotes/${operation.remoteName}/${operation.remoteBranch}`;
      const remoteObjectId = await git(binding.projectPath, [
        "rev-parse",
        "--verify",
        `${remoteRef}^{commit}`
      ]).catch(() => "");
      if (remoteObjectId !== operation.expectedRemoteObjectId) {
        throw sourceControlError(
          "Source-control remote revision is stale",
          409,
          "source_control_remote_revision_stale"
        );
      }
      await markDispatching?.();
      await git(binding.projectPath, [
        "-c",
        "core.hooksPath=/dev/null",
        "merge",
        "--ff-only",
        "--",
        operation.expectedRemoteObjectId
      ]);
      return sourceControlResultSchema.parse({
        kind: "fast_forward",
        operationId: randomUUID(),
        status: "completed",
        headObjectId: await git(binding.projectPath, [
          "rev-parse",
          "HEAD^{commit}"
        ])
      });
    }
    if (operation.kind === "review_request_create") {
      await validateBranch(operation.sourceBranch);
      await validateBranch(operation.targetBranch);
      await markDispatching?.();
      const reviewRequest = await driver.createReviewRequest({
        ...providerInput,
        title: operation.title,
        body: operation.body,
        sourceBranch: operation.sourceBranch,
        targetBranch: operation.targetBranch,
        draft: operation.draft
      });
      return sourceControlResultSchema.parse({
        kind: operation.kind,
        operationId: randomUUID(),
        status: "completed",
        headObjectId,
        reviewRequest
      });
    }
    const reviewRequest = await driver.reviewRequest({
      ...providerInput,
      number: operation.number
    });
    if (reviewRequest.headObjectId !== operation.expectedHeadObjectId) {
      throw sourceControlError(
        "Review request revision is stale",
        409,
        "source_control_review_revision_stale"
      );
    }
    if (operation.kind === "comment_create") {
      await markDispatching?.();
      const comment = await driver.createComment({
        ...providerInput,
        number: operation.number,
        body: operation.body
      });
      return sourceControlResultSchema.parse({
        kind: operation.kind,
        operationId: randomUUID(),
        status: "completed",
        headObjectId,
        comment
      });
    }
    await markDispatching?.();
    await driver.createReview({
      ...providerInput,
      number: operation.number,
      decision: operation.decision,
      body: operation.body,
      expectedHeadObjectId: operation.expectedHeadObjectId
    });
    return sourceControlResultSchema.parse({
      kind: operation.kind,
      operationId: randomUUID(),
      status: "completed",
      headObjectId
    });
  };

  return {
    async execute(ownerUserId, value) {
      const operation = sourceControlOperationSchema.parse(value);
      if (operation.kind === "remotes") {
        const { binding, headObjectId } = await executionContext(
          ownerUserId,
          operation
        );
        return sourceControlResultSchema.parse({
          kind: "remotes",
          remotes: (await remotesFor(binding.projectPath)).map(publicRemote),
          headObjectId
        });
      }
      if (!("idempotencyKey" in operation)) {
        return await executeBound(ownerUserId, operation);
      }
      const journalKey = sha256(
        JSON.stringify([ownerUserId, operation.idempotencyKey])
      );
      const digest = sha256(JSON.stringify([ownerUserId, operation]));
      return await journal(async () => {
        const operations = await readJournal();
        const existing = operations[journalKey];
        if (existing) {
          if (existing.digest !== digest) {
            throw sourceControlError(
              "Source-control idempotency key was reused",
              409,
              "source_control_idempotency_conflict"
            );
          }
          if (existing.state === "completed" && existing.result) {
            await executionContext(ownerUserId, operation);
            return existing.result;
          }
          throw sourceControlError(
            "Source-control operation outcome is indeterminate",
            409,
            "source_control_operation_indeterminate"
          );
        }
        let dispatched = false;
        const result = await executeBound(ownerUserId, operation, async () => {
          if (dispatched) return;
          dispatched = true;
          operations[journalKey] = {
            digest,
            state: "dispatching"
          };
          await writeJournal(operations);
        });
        if (!dispatched) {
          throw sourceControlError(
            "Source-control mutation did not reach its dispatch boundary",
            500,
            "source_control_dispatch_missing"
          );
        }
        operations[journalKey] = {
          digest,
          state: "completed",
          result
        };
        await writeJournal(operations);
        return result;
      });
    }
  };
};
