import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import { createGitExecutionWorkspaceDriver } from "@koed/shared/execution-workspace";

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
  host?: string;
  capabilities?: readonly string[];
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
  const managedRoot = resolve(koedHome, "managed-workspaces", "worktrees");
  const workspaceDriver = await createGitExecutionWorkspaceDriver({
    managedRoot
  });
  const identity = await workspaceDriver.inspect(repositoryPath);
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
          provider: "github",
          host: options?.host ?? "github.com",
          apiOrigin: options?.host
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
    executionGeneration: 2
  };
  const binding = {
    executionId,
    ownerUserId: userId,
    deploymentId: "44444444-4444-4444-8444-444444444444",
    deviceId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 2,
    sourceProjectPath: repositoryPath,
    projectPath: repositoryPath,
    workspaceId: identity.workspaceId,
    workspaceKind: "user_managed_checkout",
    workspaceLifecycle: "ready",
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
    getManagedConversationExecution: vi.fn(async () => execution),
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
  const runtime = createSourceControlRuntime({
    koedHome,
    requireRepository: () => repository,
    fetch: providerFetch,
    resolveCredential: credentialResolver
  });
  return {
    binding,
    credentialResolver,
    headObjectId,
    koedHome,
    providerFetch,
    repositoryPath,
    runtime
  };
};

describe("source-control runtime", () => {
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
    expect(providerFetch).toHaveBeenCalledTimes(2);
    const journal = readFileSync(
      resolve(koedHome, "state", "source-control-operations.json"),
      "utf8"
    );
    expect(journal).not.toContain("fixture-secret");
    expect(journal).toContain('"state":"completed"');
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
    ).rejects.toMatchObject({ code: "source_control_workspace_stale" });

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
