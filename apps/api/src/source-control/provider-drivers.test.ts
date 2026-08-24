import { describe, expect, it, vi } from "vitest";
import type {
  SourceControlConnection,
  SourceControlProvider
} from "@koed/shared";

import {
  sourceControlProviderDriver,
  type ProviderInput
} from "./provider-drivers.js";

const sha = "a".repeat(40);
const created = "2026-08-19T00:00:00.000Z";

const connection = (
  provider: SourceControlProvider
): SourceControlConnection => ({
  id: "11111111-1111-4111-8111-111111111111",
  provider,
  host:
    provider === "github"
      ? "github.com"
      : provider === "gitlab"
        ? "gitlab.com"
        : provider === "bitbucket"
          ? "bitbucket.org"
          : "dev.azure.com",
  apiOrigin:
    provider === "github"
      ? "https://api.github.com"
      : provider === "gitlab"
        ? "https://gitlab.com/api/v4"
        : provider === "bitbucket"
          ? "https://api.bitbucket.org/2.0"
          : "https://dev.azure.com",
  accountLabel: "Fixture account",
  credentialReference: "source-control:fixture",
  credentialGeneration: 1,
  state: "active",
  capabilities: [
    "repository_read",
    "branch_read",
    "review_request_read",
    "review_request_create",
    "checks_read",
    "comments_read",
    "comments_write",
    "reviews_write"
  ]
});

const json = (value: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" }
    })
  );

const githubFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname.endsWith("/branches/main")) {
    return json({ name: "main", commit: { sha }, protected: true });
  }
  if (url.pathname.endsWith("/branches")) {
    return json([{ name: "main", commit: { sha }, protected: true }]);
  }
  if (url.pathname.endsWith("/check-runs")) {
    return json({
      check_runs: [
        {
          id: 3,
          name: "CI",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/repo/actions/3"
        }
      ]
    });
  }
  if (url.pathname.endsWith("/comments") && method === "GET") {
    return json([
      {
        id: 4,
        user: { login: "reviewer" },
        body: "Looks good",
        created_at: created,
        html_url: "https://github.com/acme/repo/pull/7#comment-4"
      }
    ]);
  }
  if (url.pathname.endsWith("/comments") && method === "POST") {
    return json({
      id: 5,
      user: { login: "reviewer" },
      body: "Ship it",
      created_at: created,
      html_url: "https://github.com/acme/repo/pull/7#comment-5"
    });
  }
  if (url.pathname.endsWith("/reviews")) return json({ id: 9 });
  if (url.pathname.endsWith("/pulls") && method === "POST") {
    return json(githubPull(8));
  }
  if (url.pathname.endsWith("/pulls/7")) return json(githubPull(7));
  if (url.pathname.endsWith("/pulls")) return json([githubPull(7)]);
  return json({ default_branch: "main" });
});

const githubPull = (number: number) => ({
  id: number,
  node_id: `PR_${number}`,
  number,
  title: "Review fixture",
  state: "open",
  draft: false,
  head: { ref: "feature", sha },
  base: { ref: "main" },
  user: { login: "author" },
  html_url: `https://github.com/acme/repo/pull/${number}`,
  updated_at: created
});

const gitlabMerge = (number: number) => ({
  id: number,
  iid: number,
  title: "Review fixture",
  state: "opened",
  draft: false,
  source_branch: "feature",
  target_branch: "main",
  diff_refs: { head_sha: sha },
  author: { username: "author" },
  web_url: `https://gitlab.com/acme/repo/-/merge_requests/${number}`,
  updated_at: created
});

const gitlabFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname.includes("/repository/branches/main")) {
    return json({ name: "main", commit: { id: sha }, protected: true });
  }
  if (url.pathname.endsWith("/repository/branches")) {
    return json([{ name: "main", commit: { id: sha }, protected: true }]);
  }
  if (url.pathname.endsWith("/pipelines")) {
    return json([
      {
        id: 3,
        status: "success",
        web_url: "https://gitlab.com/acme/repo/-/pipelines/3"
      }
    ]);
  }
  if (url.pathname.endsWith("/notes") && method === "GET") {
    return json([
      {
        id: 4,
        author: { username: "reviewer" },
        body: "Looks good",
        created_at: created
      }
    ]);
  }
  if (url.pathname.endsWith("/notes") && method === "POST") {
    return json({
      id: 5,
      author: { username: "reviewer" },
      body: "Ship it",
      created_at: created
    });
  }
  if (url.pathname.endsWith("/approve")) return json({ approved: true });
  if (url.pathname.endsWith("/merge_requests") && method === "POST") {
    return json(gitlabMerge(8));
  }
  if (url.pathname.endsWith("/merge_requests/7")) {
    return json(gitlabMerge(7));
  }
  if (url.pathname.endsWith("/merge_requests")) {
    return json([gitlabMerge(7)]);
  }
  return json({ default_branch: "main" });
});

const bitbucketPull = (number: number) => ({
  id: number,
  title: "Review fixture",
  state: "OPEN",
  draft: false,
  source: { branch: { name: "feature" }, commit: { hash: sha } },
  destination: { branch: { name: "main" } },
  author: { nickname: "author" },
  links: {
    html: { href: `https://bitbucket.org/acme/repo/pull-requests/${number}` }
  },
  updated_on: created
});

const bitbucketFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname.includes("/refs/branches/main")) {
    return json({ name: "main", target: { hash: sha } });
  }
  if (url.pathname.endsWith("/refs/branches")) {
    return json({ values: [{ name: "main", target: { hash: sha } }] });
  }
  if (url.pathname.endsWith("/statuses")) {
    return json({
      values: [
        {
          uuid: "check-3",
          key: "CI",
          name: "CI",
          state: "SUCCESSFUL",
          url: "https://ci.example.test/3"
        }
      ]
    });
  }
  if (url.pathname.endsWith("/comments") && method === "GET") {
    return json({
      values: [
        {
          id: 4,
          user: { nickname: "reviewer" },
          content: { raw: "Looks good" },
          created_on: created
        }
      ]
    });
  }
  if (url.pathname.endsWith("/comments") && method === "POST") {
    return json({
      id: 5,
      user: { nickname: "reviewer" },
      content: { raw: "Ship it" },
      created_on: created
    });
  }
  if (url.pathname.endsWith("/approve")) return json({ approved: true });
  if (url.pathname.endsWith("/pullrequests") && method === "POST") {
    return json(bitbucketPull(8));
  }
  if (url.pathname.endsWith("/pullrequests/7")) {
    return json(bitbucketPull(7));
  }
  if (url.pathname.endsWith("/pullrequests")) {
    return json({ values: [bitbucketPull(7)] });
  }
  return json({ mainbranch: { name: "main" } });
});

const azurePull = (number: number) => ({
  pullRequestId: number,
  title: "Review fixture",
  status: "active",
  isDraft: false,
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  lastMergeSourceCommit: { commitId: sha },
  createdBy: { displayName: "author" },
  repository: { name: "repo" },
  url: `https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/${number}`,
  creationDate: created
});

const azureFetch = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname.endsWith("/refs")) {
    return json({ value: [{ name: "refs/heads/main", objectId: sha }] });
  }
  if (url.pathname.endsWith("/builds")) {
    return json({
      value: [
        {
          id: 3,
          definition: { name: "CI" },
          status: "completed",
          result: "succeeded",
          _links: { web: { href: "https://dev.azure.com/acme/build/3" } }
        }
      ]
    });
  }
  if (url.pathname.endsWith("/threads") && method === "GET") {
    return json({
      value: [
        {
          comments: [
            {
              id: 4,
              author: { displayName: "reviewer" },
              content: "Looks good",
              publishedDate: created
            }
          ]
        }
      ]
    });
  }
  if (url.pathname.endsWith("/threads") && method === "POST") {
    return json({
      comments: [
        {
          id: 5,
          author: { displayName: "reviewer" },
          content: "Ship it",
          publishedDate: created
        }
      ]
    });
  }
  if (url.pathname.endsWith("/pullrequests") && method === "POST") {
    return json(azurePull(8));
  }
  if (url.pathname.endsWith("/pullrequests/7")) return json(azurePull(7));
  if (url.pathname.endsWith("/pullrequests")) {
    return json({ value: [azurePull(7)] });
  }
  return json({ defaultBranch: "refs/heads/main" });
});

const cases: Array<{
  provider: SourceControlProvider;
  fetch: typeof fetch;
  repository: ProviderInput["repository"];
}> = [
  {
    provider: "github",
    fetch: githubFetch,
    repository: { namespace: "acme", repository: "repo", project: null }
  },
  {
    provider: "gitlab",
    fetch: gitlabFetch,
    repository: { namespace: "acme", repository: "repo", project: null }
  },
  {
    provider: "bitbucket",
    fetch: bitbucketFetch,
    repository: { namespace: "acme", repository: "repo", project: null }
  },
  {
    provider: "azure_devops",
    fetch: azureFetch,
    repository: {
      namespace: "acme",
      repository: "repo",
      project: "project"
    }
  }
];

describe.each(cases)("$provider source-control driver", (fixture) => {
  const input: ProviderInput = {
    connection: connection(fixture.provider),
    credential: { scheme: "bearer", token: "fixture-token" },
    repository: fixture.repository,
    fetch: fixture.fetch
  };
  const driver = sourceControlProviderDriver(fixture.provider);

  it("passes the common read and review workflow", async () => {
    await expect(driver.inspect(input)).resolves.toEqual({
      defaultBranch: "main",
      headObjectId: sha
    });
    await expect(driver.branches(input)).resolves.toMatchObject([
      { name: "main", objectId: sha }
    ]);
    await expect(
      driver.reviewRequests({ ...input, state: "open" })
    ).resolves.toMatchObject([{ number: 7, headObjectId: sha }]);
    await expect(
      driver.reviewRequest({ ...input, number: 7 })
    ).resolves.toMatchObject({ number: 7, headObjectId: sha });
    const checks = await driver.checks({ ...input, objectId: sha });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBeTruthy();
    await expect(
      driver.comments({ ...input, number: 7 })
    ).resolves.toMatchObject([{ author: "reviewer", body: "Looks good" }]);
    await expect(
      driver.createReviewRequest({
        ...input,
        title: "Review fixture",
        body: "Description",
        sourceBranch: "feature",
        targetBranch: "main",
        draft: false
      })
    ).resolves.toMatchObject({ number: 8, headObjectId: sha });
    await expect(
      driver.createComment({ ...input, number: 7, body: "Ship it" })
    ).resolves.toMatchObject({ body: "Ship it" });
    if (fixture.provider !== "azure_devops") {
      await expect(
        driver.createReview({
          ...input,
          number: 7,
          decision: "approve",
          body: "",
          expectedHeadObjectId: sha
        })
      ).resolves.toBeUndefined();
    }
  });

  it("keeps credentials in the provider request boundary", async () => {
    await driver.inspect(input);
    const calls = vi.mocked(fixture.fetch).mock.calls;
    const request = calls.at(-1)!;
    expect(new Headers(request[1]?.headers).get("authorization")).toBe(
      "Bearer fixture-token"
    );
    expect(String(request[0])).not.toContain("fixture-token");
  });
});
