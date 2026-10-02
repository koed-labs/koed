import { describe, expect, it } from "vitest";

import { createGithubDelegatedCli } from "./github-delegated.js";

const accounts = {
  hosts: {
    "github.com": [
      { login: "alice", active: true, state: "success" },
      { login: "octocat", active: false, state: "success" }
    ]
  }
};

const pullRequest = {
  number: 7,
  title: "Example",
  state: "open",
  user: { login: "alice" },
  head: {
    sha: "a".repeat(40),
    ref: "topic",
    repo: { id: 3, full_name: "alice/repo" }
  },
  base: {
    sha: "b".repeat(40),
    ref: "main",
    repo: { id: 2, full_name: "example/repo" }
  },
  updated_at: "2026-10-01T00:00:00Z",
  html_url: "https://github.com/example/repo/pull/7",
  body: "Review body",
  additions: 1,
  deletions: 0,
  changed_files: 1
};

describe("delegated GitHub CLI", () => {
  it("uses only github.com auth status and strips ambient credentials from child env", async () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> =
      [];
    const cli = createGithubDelegatedCli({
      environment: {
        PATH: "/usr/bin",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        GIT_ASKPASS: "secret",
        APP_SECRET: "secret"
      },
      execFile: async (_file, args, options) => {
        calls.push({ args, options });
        return { stdout: JSON.stringify(accounts) };
      }
    });
    expect(await cli.discoverAccounts()).toEqual([
      { host: "github.com", login: "alice", active: true, state: "success" },
      { host: "github.com", login: "octocat", active: false, state: "success" }
    ]);
    expect(calls[0]?.args).toEqual([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--json",
      "hosts"
    ]);
    expect(calls[0]?.options.env).toMatchObject({ PATH: "/usr/bin" });
    expect(calls[0]?.options.env).not.toHaveProperty("GH_TOKEN");
    expect(calls[0]?.options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(calls[0]?.options.env).not.toHaveProperty("GIT_ASKPASS");
    expect(calls[0]?.options.env).not.toHaveProperty("APP_SECRET");
  });

  it("fences each API read to the selected identity and fixed GitHub endpoint", async () => {
    const calls: string[][] = [];
    let activeLogin = "alice";
    const cli = createGithubDelegatedCli({
      execFile: async (_file, args) => {
        calls.push(args);
        if (args[0] === "api" && args[3] === "user")
          return { stdout: JSON.stringify({ id: 17, login: activeLogin }) };
        if (
          args[0] === "api" &&
          args[3] ===
            "user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&direction=desc&page=1&per_page=30&sort=updated"
        )
          return {
            stdout: JSON.stringify([
              { id: 2, full_name: "alice/repo", private: true }
            ])
          };
        throw new Error("no fixture for this call");
      }
    });
    await expect(
      cli.readRepositories({ expectedAccountLogin: "bob" })
    ).rejects.toMatchObject({ code: "github_account_changed" });
    activeLogin = "alice";
    expect(
      await cli.readRepositories({ expectedAccountLogin: "alice" })
    ).toEqual({
      repositories: [{ id: 2, fullName: "alice/repo", private: true }],
      hasMore: false,
      page: 1
    });
    expect(
      calls.every(
        (args) =>
          args[0] === "api" &&
          args[1] === "--hostname" &&
          args[2] === "github.com"
      )
    ).toBe(true);
  });

  it("sends an exact bounded review as JSON stdin and never places review text in argv", async () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> =
      [];
    const cli = createGithubDelegatedCli({
      execFile: async (_file, args, options) => {
        calls.push({ args, options });
        if (args[3] === "user")
          return { stdout: JSON.stringify({ id: 17, login: "alice" }) };
        if (args[3] === "repos/example/repo/pulls/7")
          return { stdout: JSON.stringify(pullRequest) };
        if (args.includes("POST"))
          return {
            stdout: JSON.stringify({
              id: 99,
              user: { login: "alice" },
              commit_id: "a".repeat(40),
              state: "COMMENTED",
              submitted_at: "2026-10-01T00:00:00Z",
              body: "Internal review text",
              html_url:
                "https://github.com/example/repo/pull/7#pullrequestreview-99"
            })
          };
        throw new Error("no fixture for this call");
      }
    });
    const result = await cli.publishReview({
      repo: "example/repo",
      number: 7,
      expectedHeadSha: "a".repeat(40),
      expectedAccountLogin: "alice",
      commitId: "a".repeat(40),
      event: "COMMENT",
      body: "Internal review text",
      comments: [
        {
          path: "src/example.ts",
          line: 9,
          side: "RIGHT",
          body: "Inline finding"
        }
      ]
    });
    const submission = calls.find(({ args }) => args.includes("POST"));
    expect(submission?.args).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/example/repo/pulls/7/reviews",
      "--method",
      "POST",
      "--input",
      "-"
    ]);
    expect(submission?.args.join(" ")).not.toContain("Internal review text");
    expect(String(submission?.options.input)).toContain("Internal review text");
    expect(JSON.parse(String(submission?.options.input))).toEqual({
      event: "COMMENT",
      commit_id: "a".repeat(40),
      body: "Internal review text",
      comments: [
        {
          path: "src/example.ts",
          line: 9,
          side: "RIGHT",
          body: "Inline finding"
        }
      ]
    });
    expect(result.review.id).toBe(99);
  });

  it("rejects malformed or stale review inputs before dispatch", async () => {
    let postCount = 0;
    const cli = createGithubDelegatedCli({
      execFile: async (_file, args) => {
        if (args.includes("POST")) postCount += 1;
        return { stdout: JSON.stringify(pullRequest) };
      }
    });
    const base = {
      repo: "example/repo",
      number: 7,
      expectedHeadSha: "a".repeat(40),
      expectedAccountLogin: "alice",
      commitId: "a".repeat(40),
      event: "APPROVE",
      body: "OK",
      comments: []
    };
    await expect(
      cli.publishReview({ ...base, repo: "../bad/repo" })
    ).rejects.toMatchObject({ code: "github_invalid_review" });
    await expect(
      cli.publishReview({ ...base, commitId: "b".repeat(40) })
    ).rejects.toMatchObject({ code: "github_invalid_review" });
    await expect(
      cli.publishReview({
        ...base,
        comments: [{ path: "../escape", line: 1, side: "RIGHT", body: "bad" }]
      })
    ).rejects.toMatchObject({ code: "github_invalid_review" });
    expect(postCount).toBe(0);
  });
});
