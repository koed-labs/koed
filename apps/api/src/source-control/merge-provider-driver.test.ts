import { describe, expect, it, vi } from "vitest";
import type { SourceControlConnection } from "@koed/shared";

import {
  dispatchGithubMerge,
  readGithubMergeReadiness,
  reconcileGithubMerge
} from "./merge-provider-driver.js";

const sha = "a".repeat(40);
const connection: SourceControlConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "github",
  host: "github.com",
  apiOrigin: "https://api.github.com",
  accountLabel: "Account",
  credentialReference: "source-control:fixture",
  credentialGeneration: 4,
  state: "active",
  capabilities: ["review_request_read", "checks_read"]
};
const context = (fetch: typeof globalThis.fetch) => ({
  connection,
  credential: { scheme: "bearer" as const, token: "secret" },
  repository: { namespace: "acme", repository: "repo", project: null },
  fetch,
  accountLabel: "Account",
  remoteIdentityHash: "b".repeat(64),
  executionId: "22222222-2222-4222-8222-222222222222",
  executionGeneration: 2,
  runnerDeploymentId: "33333333-3333-4333-8333-333333333333",
  runnerDeviceId: "44444444-4444-4444-8444-444444444444",
  credentialGeneration: 4,
  policyVersion: 1,
  policyDigest: "d".repeat(64)
});
const response = (value: unknown, status = 200, link?: string) =>
  new Response(JSON.stringify(value), {
    status,
    headers: link ? { link } : undefined
  });
const fixture = (overrides: Record<string, unknown> = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    const path = url.pathname;
    const pick = (key: string, value: unknown) =>
      key in overrides ? overrides[key] : value;
    if (path === "/repos/acme/repo")
      return response(
        pick("repo", {
          full_name: "acme/repo",
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: false
        })
      );
    if (path === "/repos/acme/repo/pulls/7")
      return response(
        pick("pr", {
          title: "Ship feature",
          state: "open",
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          merged: false,
          head: { sha, repo: { full_name: "acme/repo" } },
          base: { ref: "main" }
        })
      );
    if (path.endsWith("/rules/branches/main"))
      return response(pick("rules", []));
    if (path.endsWith("/branches/main/protection"))
      return response(
        pick("protection", {
          enforce_admins: { enabled: true },
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { checks: [{ context: "ci", app_id: 7 }] }
        })
      );
    if (path.endsWith("/pulls/7/reviews"))
      return response(
        pick("reviews", [
          {
            id: 5,
            commit_id: sha,
            user: { login: "reviewer" },
            state: "APPROVED",
            submitted_at: "2026-10-20T00:00:00Z"
          }
        ])
      );
    if (path.endsWith(`/commits/${sha}/check-runs`))
      return response(
        pick("runs", {
          total_count: 1,
          check_runs: [
            {
              id: 8,
              name: "ci",
              status: "completed",
              conclusion: "success",
              app: { id: 7 }
            }
          ]
        })
      );
    if (path.endsWith(`/commits/${sha}/statuses`))
      return response(pick("statuses", []));
    if (path.endsWith("/pulls/7/merge-async") && init?.method === "PUT")
      return response(
        pick("dispatch", {
          status: "pending",
          details: { uuid: "55555555-5555-4555-8555-555555555555" }
        }),
        202
      );
    if (path.endsWith("/merge-async/55555555-5555-4555-8555-555555555555"))
      return response(
        pick("status", {
          status: "pending",
          details: {
            uuid: "55555555-5555-4555-8555-555555555555",
            merge_method: "squash",
            merge_action: "direct_merge",
            expected_head_sha: sha,
            bypass_rules: false
          }
        })
      );
    throw new Error(`Unexpected ${path}`);
  });
  return { fetch, calls };
};

describe("GitHub merge driver", () => {
  it("uses the exact protected head, allowed method, complete readiness and no bypass", async () => {
    const { fetch, calls } = fixture();
    const readiness = await readGithubMergeReadiness(
      context(fetch),
      7,
      "squash"
    );
    expect(readiness.allowedMergeMethods).toEqual(["merge", "squash"]);
    expect(readiness.checks).toEqual([
      {
        id: "8",
        name: "ci",
        source: "check_run",
        state: "success",
        required: true,
        appId: 7,
        objectId: sha
      }
    ]);
    expect(readiness.reviews).toMatchObject([{ id: "5", state: "APPROVED" }]);
    const dispatched = await dispatchGithubMerge(context(fetch), readiness);
    expect(dispatched.outcome).toBe("pending");
    expect(calls.find((call) => call.method === "PUT")).toEqual({
      path: "/repos/acme/repo/pulls/7/merge-async",
      method: "PUT",
      body: {
        sha,
        merge_method: "squash",
        merge_action: "direct_merge",
        bypass_rules: false
      }
    });
    expect(
      await reconcileGithubMerge(
        context(fetch),
        readiness,
        dispatched.providerOperationId
      )
    ).toMatchObject({ outcome: "pending" });
  });

  it("fails closed on missing checks, changing head, rulesets and unsupported provider", async () => {
    for (const override of [
      { runs: { total_count: 0, check_runs: [] } },
      {
        runs: {
          total_count: 1,
          check_runs: [
            {
              id: 8,
              name: "ci",
              head_sha: "f".repeat(40),
              status: "completed",
              conclusion: "success",
              app: { id: 7 }
            }
          ]
        }
      },
      {
        pr: {
          title: "changed",
          state: "closed",
          draft: false,
          mergeable: false,
          mergeable_state: "dirty",
          head: { sha },
          base: { ref: "main" }
        }
      },
      { rules: [{ type: "merge_queue" }] }
    ]) {
      const { fetch } = fixture(override);
      await expect(
        readGithubMergeReadiness(context(fetch), 7, "squash")
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    const { fetch } = fixture();
    await expect(
      readGithubMergeReadiness(
        {
          ...context(fetch),
          connection: {
            ...connection,
            provider: "gitlab"
          }
        },
        7,
        "squash"
      )
    ).rejects.toMatchObject({ code: "source_control_capability_unavailable" });
  });

  it("keeps an open PR unknown if the exact operation status is unbound", async () => {
    const { fetch } = fixture({
      status: {
        status: "pending",
        details: {
          uuid: "55555555-5555-4555-8555-555555555555",
          merge_method: "merge",
          merge_action: "direct_merge",
          expected_head_sha: sha,
          bypass_rules: false
        }
      }
    });
    const readiness = await readGithubMergeReadiness(
      context(fetch),
      7,
      "squash"
    );
    expect(
      await reconcileGithubMerge(
        context(fetch),
        readiness,
        "55555555-5555-4555-8555-555555555555"
      )
    ).toEqual({
      outcome: "unknown",
      mergeCommitObjectId: null
    });
  });

  it("does not credit another actor's merge after a dispatch timeout", async () => {
    const { fetch } = fixture({
      pr: {
        title: "Ship feature",
        state: "closed",
        merged: true,
        merge_commit_sha: "c".repeat(40),
        head: { sha },
        base: { ref: "main" }
      }
    });
    const readiness = await readGithubMergeReadiness(
      context(fixture().fetch),
      7,
      "squash"
    );
    expect(await reconcileGithubMerge(context(fetch), readiness, null)).toEqual(
      { outcome: "unknown", mergeCommitObjectId: null }
    );
  });

  it("requires matching merged PR evidence for the exact operation UUID", async () => {
    const readiness = await readGithubMergeReadiness(
      context(fixture().fetch),
      7,
      "squash"
    );
    const providerOperationId = "55555555-5555-4555-8555-555555555555";
    const commit = "c".repeat(40);
    const { fetch } = fixture({
      status: { status: "merged", details: { sha: commit } },
      pr: {
        title: "Ship feature",
        state: "closed",
        merged: true,
        merge_commit_sha: commit,
        head: { sha },
        base: { ref: "main" }
      }
    });
    expect(
      await reconcileGithubMerge(context(fetch), readiness, providerOperationId)
    ).toEqual({ outcome: "merged", mergeCommitObjectId: commit });
    const failed = fixture({ status: { status: "failed" } });
    expect(
      await reconcileGithubMerge(
        context(failed.fetch),
        readiness,
        providerOperationId
      )
    ).toEqual({ outcome: "rejected", mergeCommitObjectId: null });
  });
});
