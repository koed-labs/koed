import type { Page, Route } from "@playwright/test";
import { installSyntheticApi } from "./synthetic-studio-api";

const now = new Date().toISOString();
const account = { id: "github-account-17", login: "synthetic-owner" };
const repository = {
  id: "repo-17",
  owner: "koed",
  name: "studio",
  fullName: "koed/studio",
  private: false
};
const sha = (digit: string) => digit.repeat(40);
const reviewId = "66666666-6666-4666-8666-666666666666";
const executionId = "77777777-7777-4777-8777-777777777777";
const agentId = "77777777-7777-4777-8777-777777777777";
const pullRequest = (
  number: number,
  title: string,
  author: string,
  headSha: string
) => ({
  number,
  title,
  state: "open",
  draft: false,
  merged: false,
  author: { login: author },
  requestedReviewers: [],
  headSha,
  baseSha: sha("a"),
  headBranch: `topic-${number}`,
  baseBranch: "main",
  updatedAt: now,
  url: `https://github.com/koed/studio/pull/${number}`,
  body: `Synthetic body ${number}`,
  additions: 3,
  deletions: 1,
  changedFiles: 1
});

export class PullRequestsFixture {
  connected = false;
  authorized = false;
  readonly requests: Array<{ method: string; path: string; body: unknown }> =
    [];
  private readonly operations = new Map<string, Record<string, unknown>>();
  private nextOperation = 1;
  private otherRunnerFirst = false;
  putOtherRunnerFirst() {
    this.otherRunnerFirst = true;
  }
  private review: Record<string, unknown> | null = null;
  private detailOperationId: string | null = null;
  private messages: Array<Record<string, unknown>> = [];
  private draft: Record<string, unknown> | null = null;
  private frozenReview: Record<string, unknown> | null = null;
  private readonly nextStates = new Map<
    string,
    Array<"pending" | "uncertain">
  >();
  private readonly execution = {
    id: executionId,
    projectId: null,
    provider: "codex",
    aiClientInstanceId: "codex.synthetic",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    permissionMode: "supervised",
    executionGeneration: 1,
    stateVersion: 1,
    state: "running",
    lastErrorCode: null,
    runnerKind: "local_device",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    stoppedAt: null
  };

  async install(page: Page) {
    await installSyntheticApi(page);
    await page.route("**/studio-api/github/session", async (route) => {
      await route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
    });
    await page.route("**/v1/managed-conversations**", async (route) =>
      this.handleManaged(route)
    );
    await page.route("**/studio-api/managed-conversations**", async (route) =>
      this.handleManaged(route)
    );
    await page.route("**/v1/pull-requests**", async (route) =>
      this.handle(route)
    );
    await page.route("**/studio-api/pull-requests**", async (route) =>
      this.handle(route)
    );
    return this;
  }

  queueNextState(kind: string, state: "pending" | "uncertain") {
    this.nextStates.set(kind, [...(this.nextStates.get(kind) ?? []), state]);
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path =
      url.pathname.replace(/^\/(?:v1|studio-api)\/pull-requests/, "") || "/";
    const body = request.postDataJSON() as Record<string, unknown> | null;
    this.requests.push({ method: request.method(), path, body });
    if (path === "/operations" && request.method() === "POST") {
      const payload = (body?.payload ?? {}) as Record<string, unknown>;
      const id = `00000000-0000-4000-8000-${String(this.nextOperation++).padStart(12, "0")}`;
      const nextState =
        this.nextStates.get(String(payload.kind))?.shift() ?? "completed";
      const operation = this.operation(
        id,
        payload,
        this.result(payload),
        nextState
      );
      if (payload.kind === "pull_request_details") this.detailOperationId = id;
      this.operations.set(id, operation);
      await route.fulfill({ json: { operation } });
      return;
    }
    if (path === "/operations" && request.method() === "GET") {
      await route.fulfill({
        json: {
          operations: [...this.operations.values()],
          hasMore: false,
          nextCursor: null
        }
      });
      return;
    }
    const operationMatch = path.match(/^\/operations\/([^/]+)$/);
    if (operationMatch && request.method() === "GET") {
      const operation = this.operations.get(operationMatch[1]);
      await route.fulfill({
        status: operation ? 200 : 404,
        json: operation ? { operation } : { error: "not found" }
      });
      return;
    }
    const cancelMatch = path.match(/^\/operations\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method() === "POST") {
      const operation = this.operations.get(cancelMatch[1]);
      if (operation && operation.state === "pending") {
        operation.state = "cancelled";
        operation.revision = Number(operation.revision) + 1;
      }
      await route.fulfill({
        status: operation ? 200 : 404,
        json: operation ? { operation } : { error: "not found" }
      });
      return;
    }
    if (path === "/" && request.method() === "GET") {
      await route.fulfill({
        json: { reviews: this.review ? [this.review] : [], nextCursor: null }
      });
      return;
    }
    if (path === "/" && request.method() === "POST") {
      if (!this.detailOperationId) {
        await route.fulfill({
          status: 409,
          json: { error: "missing details proof" }
        });
        return;
      }
      this.review = this.makeReview();
      await route.fulfill({ json: { review: this.review } });
      return;
    }
    const freezeMatch = path.match(/^\/([^/]+)\/draft\/freeze$/);
    if (
      freezeMatch &&
      request.method() === "POST" &&
      freezeMatch[1] === reviewId
    ) {
      if (!this.draft) {
        await route.fulfill({ status: 409, json: { error: "missing draft" } });
        return;
      }
      this.frozenReview = {
        id:
          this.draft.revision === 1
            ? "88888888-8888-4888-8888-888888888888"
            : "99999999-9999-4999-8999-999999999999",
        reviewId,
        draftRevision: this.draft.revision,
        accountId: account.id,
        connectionGeneration: 4,
        baseSha: sha("a"),
        headSha: sha("b"),
        event: this.draft.event,
        body: this.draft.body,
        findings: this.draft.findings,
        digest: (this.draft.revision === 1 ? "d" : "e").repeat(64),
        createdAt: now
      };
      await route.fulfill({ json: { frozenReview: this.frozenReview } });
      return;
    }
    const enableFixesMatch = path.match(/^\/([^/]+)\/enable-fixes$/);
    if (
      enableFixesMatch &&
      request.method() === "POST" &&
      enableFixesMatch[1] === reviewId &&
      this.review
    ) {
      this.review = {
        ...this.review,
        workMode: "fix",
        revision: Number(this.review.revision) + 1
      };
      await route.fulfill({ json: { review: this.review } });
      return;
    }
    const draftMatch = path.match(/^\/([^/]+)\/draft$/);
    if (
      draftMatch &&
      request.method() === "PUT" &&
      draftMatch[1] === reviewId
    ) {
      this.draft = {
        reviewId,
        revision: Number(this.draft?.revision ?? 0) + 1,
        origin: "owner",
        executionGeneration: 1,
        accountId: account.id,
        baseSha: sha("a"),
        headSha: sha("b"),
        event: body?.event ?? "COMMENT",
        body: body?.body ?? "",
        findings: body?.findings ?? [],
        updatedAt: now
      };
      await route.fulfill({ json: { draft: this.draft } });
      return;
    }
    const reviewPath = path.match(/^\/([^/]+)(?:\/(draft(?:\/frozen)?))?$/);
    if (
      reviewPath &&
      request.method() === "GET" &&
      reviewPath[1] === reviewId
    ) {
      if (reviewPath[2] === "draft") {
        if (!this.draft && this.messages.length)
          this.draft = {
            reviewId,
            revision: 1,
            origin: "agent",
            executionGeneration: 1,
            accountId: account.id,
            baseSha: sha("a"),
            headSha: sha("b"),
            event: "COMMENT",
            body: "Synthetic review summary",
            findings: [],
            updatedAt: now
          };
        await route.fulfill({ json: { draft: this.draft } });
      } else if (reviewPath[2] === "draft/frozen")
        await route.fulfill({ json: { frozenReview: this.frozenReview } });
      else await route.fulfill({ json: { review: this.review } });
      return;
    }
    if (path === "/runners" && request.method() === "GET") {
      await route.fulfill({
        json: {
          runners: [
            ...(this.otherRunnerFirst
              ? [
                  {
                    deviceId: "other-runner",
                    deploymentId: "55555555-5555-4555-8555-555555555555",
                    label: "Other computer"
                  }
                ]
              : []),
            {
              deviceId: "synthetic-runner",
              deploymentId: "44444444-4444-4444-8444-444444444444",
              label: "Synthetic runner"
            }
          ]
        }
      });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: `unhandled synthetic PR path ${request.method()} ${path}` }
    });
  }

  private makeReview() {
    return {
      id: reviewId,
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      agentId,
      agentVersion: 1,
      executionId: null,
      projectId: null,
      targetDeviceId: "synthetic-runner",
      targetDeploymentId: "44444444-4444-4444-8444-444444444444",
      account,
      repository: {
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        fullName: repository.fullName
      },
      pullRequestNumber: 10,
      expectedBaseSha: sha("a"),
      expectedHeadSha: sha("b"),
      connectionGeneration: 4,
      workMode: "review",
      reviewedBaseSha: null,
      reviewedHeadSha: null,
      reviewedExecutionGeneration: null,
      status: "starting",
      revision: 1,
      draftRevision: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  private async handleManaged(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path =
      url.pathname.replace(/^\/(?:v1|studio-api)\/managed-conversations/, "") ||
      "/";
    const body = request.postDataJSON() as Record<string, unknown> | null;
    this.requests.push({
      method: request.method(),
      path: `managed${path}`,
      body
    });
    if (path === "/launch-options") {
      await route.fulfill({
        json: {
          runners: [
            {
              kind: "local_device",
              deviceId: "synthetic-runner",
              displayName: "Synthetic runner"
            }
          ],
          instances: [
            {
              instanceId: "codex.synthetic",
              driverId: "codex",
              runnerDeviceId: "synthetic-runner",
              ready: true,
              readiness: "ready",
              capabilities: {
                permissionModes: [{ mode: "supervised", support: "supported" }]
              },
              models: [
                {
                  id: "gpt-6-sol",
                  displayName: "GPT 6 Sol",
                  supportedReasoningEfforts: ["high"]
                }
              ]
            }
          ],
          projects: []
        }
      });
      return;
    }
    if (path === "/access") {
      await route.fulfill({
        json: {
          backendId: url.origin,
          user: { id: "11111111-1111-4111-8111-111111111111" }
        }
      });
      return;
    }
    if (path === "/" && request.method() === "GET") {
      await route.fulfill({
        json: {
          executions: this.review?.executionId
            ? [
                {
                  ...this.execution,
                  createdAt: now,
                  updatedAt: now,
                  startedAt: now,
                  stoppedAt: null
                }
              ]
            : []
        }
      });
      return;
    }
    if (path === "/" && request.method() === "POST") {
      if (body?.pullRequestReviewId === reviewId && this.review)
        this.review = {
          ...this.review,
          executionId,
          status: "active",
          revision: 2
        };
      if (typeof body?.initialPrompt === "string")
        this.messages.push({
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          role: "user",
          content: body.initialPrompt,
          createdAt: now
        });
      await route.fulfill({
        json: {
          execution: this.execution,
          command: {
            id: "88888888-8888-4888-8888-888888888888",
            state: "accepted"
          }
        }
      });
      return;
    }
    if (path === `/${executionId}/runtime`) {
      await route.fulfill({
        json: {
          execution: this.execution,
          items: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              executionGeneration: 1,
              itemKind: "user_input",
              state: "pending",
              payload: {
                questions: [
                  {
                    id: "focus",
                    header: "Review focus",
                    question: "Which area should the review focus on?",
                    required: false,
                    options: [{ label: "Correctness" }, { label: "Security" }]
                  }
                ]
              },
              presentation: { mode: "expanded", renderer: "user_input" },
              answered: false
            }
          ],
          latestCommand: null
        }
      });
      return;
    }
    if (path === `/${executionId}/agent-state`) {
      await route.fulfill({
        json: {
          executionId,
          executionGeneration: 1,
          executionState: "running",
          activeAgentId: agentId,
          participants: [
            {
              agentId,
              name: "Busy Reviewer",
              lifecycle: "active",
              currentVersion: 1
            }
          ],
          messages: this.messages
        }
      });
      return;
    }
    if (path === `/${executionId}/project-moves/latest`) {
      await route.fulfill({ json: { move: null } });
      return;
    }
    if (path === `/${executionId}/prompts`) {
      if (body && typeof body.prompt === "string")
        this.messages.push({
          id: `cccccccc-cccc-4ccc-8ccc-${String(this.messages.length + 1).padStart(12, "0")}`,
          role: "user",
          content: body.prompt,
          createdAt: now
        });
      await route.fulfill({
        json: {
          command: {
            id: "88888888-8888-4888-8888-888888888888",
            state: "accepted"
          }
        }
      });
      return;
    }
    if (
      path ===
      `/${executionId}/runtime-items/99999999-9999-4999-8999-999999999999/respond`
    ) {
      this.messages.push({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "user",
        content: "Focus on correctness",
        createdAt: now
      });
      await route.fulfill({ json: { accepted: true } });
      return;
    }
    if (
      path === `/${executionId}/interrupt` ||
      path === `/${executionId}/stop`
    ) {
      await route.fulfill({ json: { accepted: true } });
      return;
    }
    await route.fulfill({
      status: 404,
      json: {
        error: `unhandled synthetic managed path ${request.method()} ${path}`
      }
    });
  }

  private result(payload: Record<string, unknown>) {
    switch (payload.kind) {
      case "connection_status":
        return this.connected
          ? {
              state: "connected",
              account,
              connectionGeneration: 4,
              capabilities: { readPullRequests: true, publishReviews: true }
            }
          : {
              state: "disconnected",
              account: null,
              connectionGeneration: 0,
              capabilities: { readPullRequests: false, publishReviews: false }
            };
      case "accounts":
        return {
          accounts: this.authorized
            ? [
                {
                  host: "github.com",
                  ...account,
                  active: false,
                  state: "success"
                }
              ]
            : []
        };
      case "browser_sign_in":
        this.authorized = true;
        return {
          accounts: [
            { host: "github.com", ...account, active: false, state: "success" }
          ]
        };
      case "connect":
        this.connected = true;
        this.authorized = true;
        return {
          state: "connected",
          account,
          connectionGeneration: 4,
          capabilities: { readPullRequests: true, publishReviews: true }
        };
      case "disconnect":
        this.connected = false;
        return {
          state: "disconnected",
          account: null,
          connectionGeneration: 5,
          capabilities: { readPullRequests: false, publishReviews: false }
        };
      case "repositories":
        return { repositories: [repository], hasMore: false, nextCursor: null };
      case "inbox":
        return {
          repositories: [repository],
          items: [
            {
              repository,
              pullRequest: pullRequest(
                10,
                "Requested review",
                "maya",
                sha("b")
              ),
              origin: "requested_review"
            },
            {
              repository,
              pullRequest: pullRequest(
                11,
                "Authored change",
                "synthetic-owner",
                sha("c")
              ),
              origin: "authored"
            }
          ],
          hasMore: false,
          teamRequestsIncluded: false,
          limitations: []
        };
      case "pull_request_details":
        return {
          account,
          connectionGeneration: 4,
          repository,
          pullRequestNumber: 10,
          baseSha: sha("a"),
          headSha: sha("b"),
          pullRequest: pullRequest(10, "Requested review", "maya", sha("b")),
          files: [
            {
              filename: "src/example.ts",
              status: "modified",
              additions: 3,
              deletions: 1,
              patch: "@@ -1 +1 @@\n-old\n+new"
            }
          ],
          filesTruncated: false,
          matchingProjects: []
        };
      case "prepare_push":
        return {
          proposal: {
            headRepository: { fullName: "koed/studio" },
            headBranch: "topic-10",
            remoteSha: sha("b"),
            checkoutHead: sha("c"),
            treeSha: sha("e"),
            diff: "diff --git a/src/example.ts b/src/example.ts\n+fixed",
            diffDigest: "c".repeat(64),
            commitSha: sha("f")
          }
        };
      case "reconcile_review":
        return {
          url: "https://github.com/koed/studio/pull/10#pullrequestreview-1"
        };
      case "reconcile_push":
        return { remoteSha: sha("f"), pushed: true };
      default:
        return {};
    }
  }

  private operation(
    id: string,
    payload: Record<string, unknown>,
    result: Record<string, unknown>,
    state: "pending" | "uncertain" | "completed"
  ) {
    return {
      id,
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      reviewId: typeof payload.reviewId === "string" ? payload.reviewId : null,
      targetDeviceId: "synthetic-runner",
      targetDeploymentId: "44444444-4444-4444-8444-444444444444",
      requestId: `request-${id}`,
      requestDigest: "f".repeat(64),
      payload,
      state,
      result: state === "completed" ? result : null,
      errorCode: null,
      revision: 1,
      attempt: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: state === "pending" ? null : now
    };
  }
}

export async function installPullRequestsFixture(
  page: Page,
  options: { authorized?: boolean } = {}
) {
  const fixture = new PullRequestsFixture();
  fixture.authorized = options.authorized === true;
  return fixture.install(page);
}
