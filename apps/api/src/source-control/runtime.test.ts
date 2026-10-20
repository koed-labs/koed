import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemorySourceRepository,
  SourceControlMergeRepository,
  MergeJournalEntry
} from "@koed/db";
import { createGitExecutionCheckoutDriver } from "@koed/shared/execution-checkout";

import { createSourceControlRuntime } from "./runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    execFileSync("rm", ["-rf", root]);
  }
});

const sha = "a".repeat(40);
const userId = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";

const defaultCapabilities = [
  "repository_read",
  "branch_read",
  "fetch",
  "review_request_read",
  "checks_read",
  "comments_read",
  "comments_write"
] as const;

const fixture = async (options?: {
  remoteUrl?: string;
  provider?: "azure_devops" | "bitbucket";
  host?: string;
  capabilities?: readonly string[];
  mergeJournal?: SourceControlMergeRepository;
}) => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-source-control-"));
  roots.push(root);
  const koedHome = resolve(root, "koed-home");
  const repositoryPath = resolve(root, "repository");
  mkdirSync(repositoryPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: repositoryPath
  });
  execFileSync("git", ["config", "user.name", "Koed Test"], {
    cwd: repositoryPath
  });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: repositoryPath
  });
  writeFileSync(resolve(repositoryPath, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repositoryPath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });
  execFileSync(
    "git",
    [
      "remote",
      "add",
      "origin",
      options?.remoteUrl ?? "https://github.com/acme/repo.git"
    ],
    { cwd: repositoryPath }
  );
  const managedRoot = resolve(koedHome, "managed-checkouts", "worktrees");
  const checkoutDriver = await createGitExecutionCheckoutDriver({
    managedRoot
  });
  const identity = await checkoutDriver.inspect(repositoryPath);
  const headObjectId = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryPath,
    encoding: "utf8"
  }).trim();
  mkdirSync(resolve(koedHome, "config"), { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(koedHome, "config", "source-control-connections.json"),
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: connectionId,
          provider: options?.provider ?? "github",
          host: options?.host ?? "github.com",
          apiOrigin:
            options?.provider === "azure_devops"
              ? "https://dev.azure.com"
              : options?.provider === "bitbucket"
                ? "https://api.bitbucket.org/2.0"
                : options?.host
                  ? `https://${options.host}/api/v3`
                  : "https://api.github.com",
          accountLabel: "Fixture account",
          credentialReference: "source-control:fixture",
          credentialGeneration: 4,
          state: "active",
          capabilities: options?.capabilities ?? defaultCapabilities
        }
      ]
    }),
    { mode: 0o600 }
  );
  const execution = {
    id: executionId,
    ownerUserId: userId,
    executionGeneration: 2,
    runnerDeploymentId: "44444444-4444-4444-8444-444444444444",
    runnerDeviceId: "55555555-5555-4555-8555-555555555555",
    state: "running"
  };
  const binding = {
    executionId,
    ownerUserId: userId,
    deploymentId: "44444444-4444-4444-8444-444444444444",
    deviceId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 2,
    sourceProjectPath: repositoryPath,
    projectPath: repositoryPath,
    checkoutId: identity.checkoutId,
    checkoutKind: "user_managed_checkout",
    checkoutLifecycle: "ready",
    cleanupState: "not_requested",
    vcsDriver: "git",
    localRepositoryCommonDirectory: identity.localRepositoryCommonDirectory,
    localGitDirectory: identity.localGitDirectory,
    repositoryIdentityHash: identity.repositoryIdentityHash,
    worktreeIdentityHash: identity.worktreeIdentityHash,
    baseRef: identity.baseRef,
    baseObjectId: identity.baseObjectId,
    branchRef: identity.branchRef,
    headObjectId,
    creationOperationId: null,
    localSessionId: null,
    providerThreadId: null,
    transcriptPath: null,
    managedHome: null,
    providerCliVersion: null,
    sourceGenerationId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const repository = {
    getManagedConversationExecution: vi.fn(async () => null),
    getManagedConversationRuntimeBinding: vi.fn(async () => binding)
  } as unknown as MemorySourceRepository;
  const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/pulls/7") && init?.method === "GET") {
      return new Response(
        JSON.stringify({
          id: 7,
          node_id: "PR_7",
          number: 7,
          title: "Fixture review",
          state: "open",
          draft: false,
          head: { ref: "feature", sha },
          base: { ref: "main" },
          user: { login: "author" },
          html_url: "https://github.com/acme/repo/pull/7",
          updated_at: "2026-08-19T00:00:00.000Z"
        }),
        { status: 200 }
      );
    }
    if (url.pathname.endsWith("/pulls") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: 7,
          node_id: "PR_7",
          number: 7,
          title: "Fixture review",
          state: "open",
          draft: false,
          head: { ref: "feature", sha },
          base: { ref: "main" },
          user: { login: "author" },
          html_url: "https://github.com/acme/repo/pull/7",
          updated_at: "2026-08-19T00:00:00.000Z"
        }),
        { status: 201 }
      );
    }
    if (url.pathname.endsWith("/comments") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          id: 8,
          user: { login: "reviewer" },
          body: "Ship it",
          created_at: "2026-08-19T00:00:00.000Z",
          html_url: "https://github.com/acme/repo/pull/7#comment-8"
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected provider request: ${url.pathname}`);
  });
  const credentialResolver = vi.fn(async () =>
    JSON.stringify({ scheme: "bearer", token: "fixture-secret" })
  );
  const assertExecutionAuthority = vi.fn(async (owner: string) => {
    if (owner !== userId)
      throw Object.assign(new Error("Execution not found"), {
        statusCode: 404
      });
    return execution;
  });
  const onReviewRequestCreated = vi.fn(async () => undefined);
  const runtime = createSourceControlRuntime({
    assertExecutionAuthority,
    koedHome,
    requireRepository: () => repository,
    fetch: providerFetch,
    resolveCredential: credentialResolver,
    onReviewRequestCreated,
    mergeJournal: options?.mergeJournal
  });
  return {
    assertExecutionAuthority,
    binding,
    credentialResolver,
    headObjectId,
    koedHome,
    providerFetch,
    onReviewRequestCreated,
    repositoryPath,
    runtime
  };
};

describe("source-control runtime", () => {
  it.each([
    {
      remoteUrl: "git@github.com:acme/repo.git",
      unavailable: ["fetch", "push"]
    },
    {
      remoteUrl: "https://bitbucket.org/acme/repo.git",
      provider: "bitbucket" as const,
      host: "bitbucket.org",
      unavailable: ["reviews_write"]
    },
    {
      remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
      provider: "azure_devops" as const,
      host: "dev.azure.com",
      unavailable: ["reviews_write"]
    }
  ])("advertises usable operations for $remoteUrl", async (options) => {
    const { runtime, credentialResolver } = await fixture({
      ...options,
      capabilities: [...defaultCapabilities, "push", "reviews_write"]
    });
    const result = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    expect(result.kind).toBe("remotes");
    if (result.kind !== "remotes") throw new Error("Expected remotes");
    const remote = result.remotes[0]!;
    expect(remote.connectionState).toBe("connected");
    expect(remote.capabilities).toEqual(
      [...defaultCapabilities, "push", "reviews_write"].filter(
        (capability) => !options.unavailable.includes(capability)
      )
    );
    const operation = options.unavailable.includes("fetch")
      ? {
          kind: "fetch" as const,
          remoteName: "origin"
        }
      : {
          kind: "review_create" as const,
          number: 7,
          decision: "approve" as const,
          body: "Approved"
        };
    await expect(
      runtime.execute(userId, {
        contractVersion: 1,
        executionId,
        executionGeneration: 2,
        remoteIdentityHash: remote.remoteIdentityHash,
        expectedHeadObjectId: "a".repeat(40),
        credentialGeneration: 4,
        idempotencyKey: "unavailable-operation",
        ...operation
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(credentialResolver).not.toHaveBeenCalled();
  });
  it("connects a standard Azure SSH Project remote to its public API connection", async () => {
    const { runtime, credentialResolver } = await fixture({
      provider: "azure_devops",
      host: "dev.azure.com",
      remoteUrl: "git@ssh.dev.azure.com:v3/acme/project/repo"
    });
    const result = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    expect(result).toMatchObject({
      kind: "remotes",
      remotes: [
        {
          provider: "azure_devops",
          connectionState: "connected",
          connectionId,
          locator: { namespace: "acme", project: "project", repository: "repo" }
        }
      ]
    });
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("requires current assignment before accessing source-control credentials", async () => {
    const {
      runtime,
      assertExecutionAuthority,
      credentialResolver,
      providerFetch
    } = await fixture();
    assertExecutionAuthority.mockRejectedValueOnce(
      Object.assign(new Error("Assignment changed"), { statusCode: 409 })
    );
    await expect(
      runtime.execute(userId, {
        contractVersion: 1,
        executionId,
        executionGeneration: 2,
        kind: "remotes"
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(credentialResolver).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("discovers an exact remote without exposing its URL or credential", async () => {
    const { headObjectId, runtime } = await fixture();
    const result = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    expect(result).toMatchObject({
      kind: "remotes",
      headObjectId,
      remotes: [
        {
          remoteName: "origin",
          provider: "github",
          host: "github.com",
          connectionId,
          credentialGeneration: 4,
          connectionState: "connected",
          locator: { namespace: "acme", repository: "repo" }
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("https://github.com");
  });

  it("binds an enterprise host only through its exact configured provider connection", async () => {
    const { runtime } = await fixture({
      remoteUrl: "https://git.example.test/acme/repo.git",
      host: "git.example.test"
    });
    const result = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    expect(result).toMatchObject({
      kind: "remotes",
      remotes: [
        {
          provider: "github",
          host: "git.example.test",
          connectionState: "connected"
        }
      ]
    });
  });

  it("denies an ungranted capability before resolving credentials", async () => {
    const { credentialResolver, runtime } = await fixture({
      capabilities: ["repository_read"]
    });
    const remotes = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("Unexpected result");
    await expect(
      runtime.execute(userId, {
        contractVersion: 1,
        executionId,
        executionGeneration: 2,
        remoteIdentityHash: remotes.remotes[0]!.remoteIdentityHash,
        kind: "comments",
        number: 7,
        cursor: null
      })
    ).rejects.toMatchObject({ code: "source_control_capability_denied" });
    expect(credentialResolver).not.toHaveBeenCalled();
  });

  it("fast-forwards only to the fetched revision named by the request", async () => {
    const { headObjectId, repositoryPath, runtime } = await fixture({
      capabilities: ["repository_read", "fetch"]
    });
    execFileSync("git", ["checkout", "-b", "upstream-fixture"], {
      cwd: repositoryPath
    });
    writeFileSync(resolve(repositoryPath, "upstream.txt"), "upstream\n");
    execFileSync("git", ["add", "upstream.txt"], { cwd: repositoryPath });
    execFileSync("git", ["commit", "-m", "upstream fixture"], {
      cwd: repositoryPath
    });
    const remoteObjectId = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
      encoding: "utf8"
    }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: repositoryPath });
    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/main", remoteObjectId],
      { cwd: repositoryPath }
    );
    const remotes = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("Unexpected result");
    const result = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      remoteIdentityHash: remotes.remotes[0]!.remoteIdentityHash,
      kind: "fast_forward",
      remoteName: "origin",
      remoteBranch: "main",
      expectedRemoteObjectId: remoteObjectId,
      expectedHeadObjectId: headObjectId,
      credentialGeneration: 4,
      idempotencyKey: "source-fast-forward:fixture-0001"
    });
    expect(result).toMatchObject({
      kind: "fast_forward",
      headObjectId: remoteObjectId
    });
  });

  it("makes a revision-bound write once and replays its durable result", async () => {
    const { koedHome, providerFetch, runtime } = await fixture();
    const remotes = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("Unexpected result");
    const operation = {
      contractVersion: 1 as const,
      executionId,
      executionGeneration: 2,
      remoteIdentityHash: remotes.remotes[0]!.remoteIdentityHash,
      kind: "comment_create" as const,
      number: 7,
      body: "Ship it",
      expectedHeadObjectId: sha,
      credentialGeneration: 4,
      idempotencyKey: "source-comment:fixture-0001"
    };
    const first = await runtime.execute(userId, operation);
    const second = await runtime.execute(userId, operation);
    expect(second).toEqual(first);
    await expect(
      runtime.execute("66666666-6666-4666-8666-666666666666", operation)
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      runtime.execute("66666666-6666-4666-8666-666666666666", {
        ...operation,
        body: "Different comment"
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const journal = readFileSync(
      resolve(koedHome, "state", "source-control-operations.json"),
      "utf8"
    );
    expect(journal).not.toContain("fixture-secret");
    expect(journal).toContain('"state":"completed"');
  });

  it("observes only a real provider-created review request and reapplies its durable journal result", async () => {
    const { runtime, providerFetch, onReviewRequestCreated, headObjectId } =
      await fixture({
        capabilities: [...defaultCapabilities, "review_request_create"]
      });
    const remotes = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("Unexpected result");
    const operation = {
      contractVersion: 1 as const,
      executionId,
      executionGeneration: 2,
      remoteIdentityHash: remotes.remotes[0]!.remoteIdentityHash,
      kind: "review_request_create" as const,
      title: "Fixture review",
      body: "Ready",
      sourceBranch: "feature",
      targetBranch: "main",
      draft: false,
      expectedHeadObjectId: headObjectId,
      credentialGeneration: 4,
      idempotencyKey: "source-review:fixture-0001"
    };
    const first = await runtime.execute(userId, operation);
    expect(first).toMatchObject({
      kind: "review_request_create",
      reviewRequest: {
        number: 7,
        webUrl: "https://github.com/acme/repo/pull/7"
      }
    });
    expect(onReviewRequestCreated).toHaveBeenCalledWith({
      ownerUserId: userId,
      executionId,
      executionGeneration: 2,
      provider: "github.com",
      number: 7,
      url: "https://github.com/acme/repo/pull/7"
    });
    expect(await runtime.execute(userId, operation)).toEqual(first);
    expect(onReviewRequestCreated).toHaveBeenCalledTimes(2);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed for stale execution, remote, credential, and idempotency state", async () => {
    const { koedHome, runtime } = await fixture();
    await expect(
      runtime.execute(userId, {
        contractVersion: 1,
        executionId,
        executionGeneration: 3,
        kind: "remotes"
      })
    ).rejects.toMatchObject({ code: "source_control_checkout_stale" });

    const remotes = await runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("Unexpected result");
    const base = {
      contractVersion: 1 as const,
      executionId,
      executionGeneration: 2,
      kind: "comment_create" as const,
      number: 7,
      body: "Ship it",
      expectedHeadObjectId: sha,
      credentialGeneration: 3,
      idempotencyKey: "source-comment:fixture-0002"
    };
    await expect(
      runtime.execute(userId, {
        ...base,
        remoteIdentityHash: "f".repeat(64)
      })
    ).rejects.toMatchObject({ code: "source_control_connection_required" });
    await expect(
      runtime.execute(userId, {
        ...base,
        remoteIdentityHash: remotes.remotes[0]!.remoteIdentityHash
      })
    ).rejects.toMatchObject({ code: "source_control_credential_stale" });
    expect(() =>
      readFileSync(
        resolve(koedHome, "state", "source-control-operations.json"),
        "utf8"
      )
    ).toThrow();
  });
});

const mergeJournalFixture = () => {
  const entries = new Map<string, MergeJournalEntry>();
  const repository = {
    async prepare(input: any) {
      const entry: MergeJournalEntry = {
        ...input,
        state: "prepared",
        providerOperationId: null,
        mergeCommitObjectId: null,
        claimedAt: null
      };
      entries.set(entry.id, entry);
      return entry;
    },
    async get(_owner: string, id: string) {
      return entries.get(id) ?? null;
    },
    async unresolved(owner: string, prKey: string) {
      return (
        [...entries.values()].find(
          (entry) =>
            entry.ownerUserId === owner &&
            entry.prKey === prKey &&
            ["claimed", "pending", "unknown"].includes(entry.state)
        ) ?? null
      );
    },
    async claim(owner: string, id: string) {
      const entry = entries.get(id);
      if (
        !entry ||
        entry.ownerUserId !== owner ||
        entry.state !== "prepared" ||
        entry.expiresAt.getTime() <= Date.now() ||
        (await repository.unresolved(owner, entry.prKey))
      )
        return null;
      entry.state = "claimed";
      entry.claimedAt = new Date();
      return entry;
    },
    async setOutcome(
      _owner: string,
      id: string,
      state: MergeJournalEntry["state"],
      providerOperationId: string | null,
      mergeCommitObjectId: string | null
    ) {
      const entry = entries.get(id);
      if (!entry) return null;
      entry.state = state;
      entry.providerOperationId =
        providerOperationId ?? entry.providerOperationId;
      entry.mergeCommitObjectId =
        mergeCommitObjectId ?? entry.mergeCommitObjectId;
      return entry;
    }
  } as unknown as SourceControlMergeRepository;
  return { repository, entries };
};

describe("version-2 merge runtime", () => {
  const mergeOperationId = "77777777-7777-4777-8777-777777777777";
  const desktopAuthorization = "Koed-Desktop fixture:secret";
  const setup = async () => {
    const journal = mergeJournalFixture();
    const test = await fixture({ mergeJournal: journal.repository });
    const remotes = await test.runtime.execute(userId, {
      contractVersion: 1,
      executionId,
      executionGeneration: 2,
      kind: "remotes"
    });
    if (remotes.kind !== "remotes") throw new Error("No remotes");
    const remoteIdentityHash = remotes.remotes[0]!.remoteIdentityHash;
    writeFileSync(
      resolve(test.koedHome, "config", "source-control-merge-policy.json"),
      JSON.stringify({
        version: 1,
        repositories: [
          {
            connectionId,
            remoteIdentityHash,
            targetBranch: "main",
            allowedMethods: ["merge", "squash"]
          }
        ]
      }),
      { mode: 0o600 }
    );
    let checksPassed = true;
    let reviewId = 5;
    let dispatchFails = false;
    const operations: string[] = [];
    test.providerFetch.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (init?.method === "PUT") {
        operations.push(path);
        if (dispatchFails) throw new Error("provider timeout");
        return new Response(
          JSON.stringify({
            status: "pending",
            details: { uuid: mergeOperationId }
          }),
          { status: 202 }
        );
      }
      const value =
        path === "/repos/acme/repo"
          ? {
              full_name: "acme/repo",
              allow_merge_commit: true,
              allow_squash_merge: true,
              allow_rebase_merge: false
            }
          : path === "/repos/acme/repo/pulls/7"
            ? {
                title: "Fixture review",
                state: "open",
                draft: false,
                merged: false,
                mergeable: true,
                mergeable_state: "clean",
                head: {
                  sha: test.headObjectId,
                  repo: { full_name: "acme/repo" }
                },
                base: { ref: "main" }
              }
            : path.endsWith("/rules/branches/main")
              ? []
              : path.endsWith("/branches/main/protection")
                ? {
                    enforce_admins: { enabled: true },
                    required_pull_request_reviews: {
                      required_approving_review_count: 1
                    },
                    required_status_checks: {
                      checks: [{ context: "ci", app_id: 7 }]
                    }
                  }
                : path.endsWith("/pulls/7/reviews")
                  ? [
                      {
                        id: reviewId,
                        commit_id: test.headObjectId,
                        user: { login: "reviewer" },
                        state: "APPROVED",
                        submitted_at: "2026-10-20T00:00:00Z"
                      }
                    ]
                  : path.endsWith(`/commits/${test.headObjectId}/check-runs`)
                    ? {
                        total_count: 1,
                        check_runs: [
                          {
                            id: 8,
                            name: "ci",
                            status: "completed",
                            conclusion: checksPassed ? "success" : "failure",
                            app: { id: 7 }
                          }
                        ]
                      }
                    : path.endsWith(`/commits/${test.headObjectId}/statuses`)
                      ? []
                      : path.endsWith(`/merge-async/${mergeOperationId}`)
                        ? {
                            status: "pending",
                            details: {
                              uuid: mergeOperationId,
                              merge_method: "squash",
                              merge_action: "direct_merge",
                              expected_head_sha: test.headObjectId,
                              bypass_rules: false
                            }
                          }
                        : null;
      if (value === null) throw new Error(`Unexpected ${path}`);
      return new Response(JSON.stringify(value), { status: 200 });
    });
    const base = {
      contractVersion: 2,
      executionId,
      executionGeneration: 2,
      remoteIdentityHash
    } as const;
    const prepare = async () => {
      const result = await test.runtime.executeV2(
        userId,
        {
          ...base,
          kind: "review_request_merge_prepare",
          reviewRequestNumber: 7,
          mergeMethod: "squash"
        },
        desktopAuthorization
      );
      if (result.kind !== "review_request_merge_prepared")
        throw new Error("Not prepared");
      return result;
    };
    const claim = (
      prepared: Awaited<ReturnType<typeof prepare>>,
      proof?: string
    ) =>
      test.runtime.executeV2(
        userId,
        {
          ...base,
          kind: "review_request_merge",
          operationId: prepared.operationId,
          approvalProof:
            proof ??
            createHmac("sha256", desktopAuthorization)
              .update(
                JSON.stringify([
                  prepared.operationId,
                  prepared.readinessSnapshotDigest,
                  prepared.expiresAt
                ])
              )
              .digest("hex")
        },
        desktopAuthorization
      );
    const status = (operationId: string) =>
      test.runtime.executeV2(
        userId,
        {
          ...base,
          kind: "review_request_merge_status",
          operationId
        },
        desktopAuthorization
      );
    return {
      ...test,
      journal,
      base,
      prepare,
      claim,
      status,
      operations,
      setChecksPassed: (value: boolean) => {
        checksPassed = value;
      },
      setReviewId: (value: number) => {
        reviewId = value;
      },
      setDispatchFails: (value: boolean) => {
        dispatchFails = value;
      }
    };
  };

  it("requires exact native proof, consumes one dispatch and fences unknown recovery", async () => {
    const fixture = await setup();
    expect(
      await fixture.runtime.executeV2(
        userId,
        {
          ...fixture.base,
          kind: "review_request_merge_capability",
          reviewRequestNumber: 7
        },
        desktopAuthorization
      )
    ).toMatchObject({
      kind: "review_request_merge_capability",
      available: true,
      allowedMergeMethods: ["merge", "squash"],
      provider: "github"
    });
    const prepared = await fixture.prepare();
    await expect(fixture.claim(prepared, "0".repeat(64))).rejects.toMatchObject(
      { code: "source_control_approval_required" }
    );
    fixture.setDispatchFails(true);
    expect(await fixture.claim(prepared)).toMatchObject({ outcome: "unknown" });
    expect(await fixture.claim(prepared)).toMatchObject({ outcome: "unknown" });
    expect(fixture.operations).toHaveLength(1);
    expect(await fixture.status(prepared.operationId)).toMatchObject({
      outcome: "unknown"
    });
    await expect(fixture.prepare()).rejects.toMatchObject({
      code: "source_control_operation_indeterminate"
    });
    expect(fixture.operations).toHaveLength(1);
  });

  it("requires fresh review when checks change on the same head", async () => {
    const fixture = await setup();
    const prepared = await fixture.prepare();
    fixture.setChecksPassed(false);
    await expect(fixture.claim(prepared)).rejects.toMatchObject({
      code: "source_control_stale"
    });
    expect(fixture.operations).toHaveLength(0);
    fixture.setChecksPassed(true);
    const renewed = await fixture.prepare();
    expect(renewed.operationId).not.toBe(prepared.operationId);
    expect(await fixture.claim(renewed)).toMatchObject({ outcome: "pending" });
    expect(fixture.operations).toHaveLength(1);
    const providerCalls = fixture.providerFetch.mock.calls;
    expect(providerCalls.length).toBeGreaterThan(0);
    for (const [url, init] of providerCalls) {
      expect(String(url)).not.toContain("fixture-secret");
      expect(JSON.stringify(init?.body ?? null)).not.toContain(
        "fixture-secret"
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-secret"
      );
    }
    expect(JSON.stringify(renewed)).not.toContain("fixture-secret");
    expect(
      JSON.stringify(await fixture.status(renewed.operationId))
    ).not.toContain("fixture-secret");
    expect(
      JSON.stringify(fixture.assertExecutionAuthority.mock.calls)
    ).not.toContain("fixture-secret");
  });

  it("binds the exact approval identity even when approval count stays constant", async () => {
    const fixture = await setup();
    const prepared = await fixture.prepare();
    fixture.setReviewId(6);
    await expect(fixture.claim(prepared)).rejects.toMatchObject({
      code: "source_control_stale"
    });
    expect(fixture.operations).toHaveLength(0);
  });

  it("invalidates Native approval when the private grant changes but still allows the chosen method", async () => {
    const fixture = await setup();
    const prepared = await fixture.prepare();
    writeFileSync(
      resolve(fixture.koedHome, "config", "source-control-merge-policy.json"),
      JSON.stringify({
        version: 1,
        repositories: [
          {
            connectionId,
            remoteIdentityHash: fixture.base.remoteIdentityHash,
            targetBranch: "main",
            allowedMethods: ["squash"]
          }
        ]
      }),
      { mode: 0o600 }
    );
    await expect(fixture.claim(prepared)).rejects.toMatchObject({
      code: "source_control_stale"
    });
    expect(fixture.operations).toHaveLength(0);
  });

  it.each(["lease", "generation", "owner"] as const)(
    "does not claim or dispatch when runner %s authority changes during readiness reads",
    async (change) => {
      const fixture = await setup();
      const prepared = await fixture.prepare();
      const originalFetch = fixture.providerFetch.getMockImplementation()!;
      const originalAuthority = await fixture.assertExecutionAuthority(
        userId,
        executionId
      );
      let changed = false;
      fixture.providerFetch.mockImplementation(async (input, init) => {
        const response = await originalFetch(input, init);
        if (String(input).includes("/check-runs")) changed = true;
        return response;
      });
      fixture.assertExecutionAuthority.mockImplementation(async () => {
        if (!changed) return originalAuthority;
        if (change === "owner")
          throw Object.assign(new Error("Execution not found"), {
            statusCode: 404
          });
        return {
          ...originalAuthority,
          ...(change === "generation"
            ? { executionGeneration: originalAuthority.executionGeneration + 1 }
            : { state: "completed" })
        };
      });
      await expect(fixture.claim(prepared)).rejects.toMatchObject({
        statusCode: change === "owner" ? 404 : 409
      });
      expect(changed).toBe(true);
      expect(fixture.journal.entries.get(prepared.operationId)?.state).toBe(
        "prepared"
      );
      expect(fixture.operations).toHaveLength(0);
    }
  );

  it("does not claim when the provider credential rotates during readiness reads", async () => {
    const fixture = await setup();
    const prepared = await fixture.prepare();
    const originalFetch = fixture.providerFetch.getMockImplementation()!;
    let rotated = false;
    fixture.providerFetch.mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).includes("/check-runs")) rotated = true;
      return response;
    });
    fixture.credentialResolver.mockImplementation(async () =>
      JSON.stringify({
        scheme: "bearer",
        token: rotated ? "new-secret" : "fixture-secret"
      })
    );
    await expect(fixture.claim(prepared)).rejects.toMatchObject({
      code: "source_control_stale"
    });
    expect(rotated).toBe(true);
    expect(fixture.journal.entries.get(prepared.operationId)?.state).toBe(
      "prepared"
    );
    expect(fixture.operations).toHaveLength(0);
  });
});
