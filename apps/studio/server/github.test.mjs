import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGithubConnector } from "./github.mjs";

const hostAccounts = (...logins) => ({
  hosts: {
    "github.com": logins.map(
      ({ login, active = false, state = "success" }) => ({
        login,
        active,
        state
      })
    )
  }
});

const pullRequest = ({ number = 1, headSha = "a".repeat(40) } = {}) => ({
  number,
  title: "Example PR",
  state: "open",
  draft: false,
  merged: false,
  user: { login: "alice" },
  requested_reviewers: [{ login: "octocat" }],
  head: {
    sha: headSha,
    ref: "topic",
    repo: { id: 2, full_name: "alice/repo" }
  },
  base: {
    sha: "b".repeat(40),
    ref: "main",
    repo: { id: 1, full_name: "example/repo" }
  },
  updated_at: "2026-09-22T00:00:00Z",
  html_url: `https://github.com/example/repo/pull/${number}`,
  body: "Pull request body",
  additions: 2,
  deletions: 1,
  changed_files: 1,
  comments: 1,
  review_comments: 1
});

const searchItem = ({ number, author = "alice", title = `PR ${number}` }) => ({
  number,
  title,
  user: { login: author },
  updated_at: "2026-10-01T00:00:00Z",
  html_url: `https://github.com/example/repo/pull/${number}`,
  repository_url: "https://api.github.com/repos/example/repo"
});

const createFixture = ({
  api,
  accounts = [{ login: "alice", active: true }],
  env
} = {}) => {
  const calls = [];
  let activeLogin = accounts.find((account) => account.active)?.login ?? null;
  const execFile = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(file, "gh");
    assert.equal(typeof options.timeout, "number");
    assert.equal(typeof options.maxBuffer, "number");
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.GIT_ASKPASS, undefined);
    if (args[0] === "auth" && args[1] === "status") {
      return {
        stdout: JSON.stringify(
          hostAccounts(
            ...accounts.map((account) => ({
              ...account,
              active: account.login === activeLogin
            }))
          )
        )
      };
    }
    if (args[0] === "auth" && args[1] === "switch") {
      activeLogin = args[args.indexOf("--user") + 1];
      return { stdout: "" };
    }
    if (args[0] === "auth" && args[1] === "login") {
      activeLogin = accounts[0]?.login ?? null;
      return { stdout: "" };
    }
    if (args[0] === "api" && args[3] === "user")
      return { stdout: JSON.stringify({ id: 123, login: activeLogin }) };
    if (args[0] === "api") {
      const endpoint = args[3];
      if (typeof api === "function")
        return { stdout: JSON.stringify(await api(endpoint, args)) };
      return { stdout: JSON.stringify(api?.[endpoint] ?? []) };
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
  const connector = createGithubConnector({ execFile, environment: env });
  return {
    connector,
    calls,
    get activeLogin() {
      return activeLogin;
    },
    setActiveLogin(login) {
      activeLogin = login;
    }
  };
};

describe("GitHub delegated CLI connector", () => {
  it("discovers only public GitHub accounts, selects explicitly, and never reads a token", async () => {
    const fixture = createFixture({
      accounts: [
        { login: "alice", active: true },
        { login: "octocat", active: false }
      ],
      env: {
        PATH: "/usr/bin",
        GH_TOKEN: "must-not-inherit",
        GITHUB_TOKEN: "must-not-inherit-either",
        GIT_ASKPASS: "must-not-inherit",
        APP_ACCESS_TOKEN: "must-not-inherit",
        HOME: "/unexpected"
      }
    });
    assert.deepEqual(await fixture.connector.discoverAccounts(), [
      { host: "github.com", login: "alice", active: true, state: "success" },
      { host: "github.com", login: "octocat", active: false, state: "success" }
    ]);
    const status = await fixture.connector.selectAccount({ login: "octocat" });
    assert.equal(status.state, "connected");
    assert.equal(status.login, "octocat");
    assert.equal(status.accountId, "123");
    assert.equal(status.capabilities.publishReviews, true);
    assert.equal(fixture.activeLogin, "octocat");
    assert.deepEqual(
      fixture.calls.find(
        (call) => call.args[0] === "auth" && call.args[1] === "switch"
      )?.args,
      ["auth", "switch", "--hostname", "github.com", "--user", "octocat"]
    );
    assert.ok(
      fixture.calls.every(
        ({ args }) =>
          !(args[0] === "auth" && args[1] === "token") &&
          !args.includes("--show-token")
      )
    );
    assert.equal(JSON.stringify(status).includes("must-not-inherit"), false);
  });

  it("keeps sign-in explicit and uses the browser login command only when requested", async () => {
    const fixture = createFixture({
      accounts: [{ login: "alice", active: false }]
    });
    assert.equal(fixture.calls.length, 0);
    const status = await fixture.connector.beginBrowserSignIn();
    assert.equal(status.login, "alice");
    assert.deepEqual(
      fixture.calls.find((call) => call.args[1] === "login")?.args,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        "https"
      ]
    );
  });

  it("connects to the active identity and invalidates state on account drift or disconnect races", async () => {
    const fixture = createFixture({
      accounts: [{ login: "alice", active: true }]
    });
    const status = await fixture.connector.connect();
    assert.equal(status.login, "alice");
    assert.equal(
      status.connectionGeneration,
      fixture.connector.getGeneration()
    );

    const waiting = createFixture({
      accounts: [{ login: "alice", active: true }]
    });
    let release;
    const pending = new Promise((resolve) => (release = resolve));
    const original = waiting.connector.connect.bind(waiting.connector);
    const delayed = {
      ...waiting.connector,
      getActiveAccount: async () => {
        await pending;
        return {
          host: "github.com",
          login: "alice",
          active: true,
          state: "success"
        };
      }
    };
    const racing = createGithubConnector({ delegatedCli: delayed });
    const connecting = racing.connect();
    racing.disconnect();
    release();
    await connecting;
    assert.equal(racing.getStatus().state, "disconnected");
    assert.equal(typeof original, "function");
  });

  it("rejects a read if the selected gh account changes while the API call is in flight", async () => {
    let fixture;
    fixture = createFixture({
      api: async (endpoint) => {
        if (endpoint.startsWith("user/repos?")) {
          fixture.setActiveLogin("someone-else");
          return [];
        }
        return [];
      }
    });
    await fixture.connector.connect();
    await assert.rejects(
      fixture.connector.readRepositories(),
      (error) => error.code === "github_account_changed"
    );
    assert.equal(fixture.connector.getStatus().state, "error");
    assert.equal(fixture.connector.getStatus().login, null);
  });

  it("uses fixed GitHub API paths and validates repository and page inputs before subprocess execution", async () => {
    const fixture = createFixture({
      api: async (endpoint) => {
        if (endpoint.startsWith("user/repos?"))
          return [{ id: 10, full_name: "alice/repo", private: true }];
        return [];
      }
    });
    await fixture.connector.connect();
    assert.deepEqual(await fixture.connector.readRepositories(), {
      repositories: [{ id: 10, fullName: "alice/repo", private: true }],
      hasMore: false,
      page: 1
    });
    const before = fixture.calls.length;
    await assert.rejects(
      fixture.connector.readPullRequests({ repo: "../attacker?x=1" }),
      (error) => error.code === "github_invalid_repository"
    );
    await assert.rejects(
      fixture.connector.readRepositories({ page: 0 }),
      (error) => error.code === "github_invalid_page"
    );
    assert.equal(fixture.calls.length, before);
    const endpoint = fixture.calls.find(
      (call) => call.args[0] === "api" && call.args[3]?.startsWith("user/repos")
    )?.args[3];
    assert.equal(
      endpoint,
      "user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&direction=desc&page=1&per_page=30&sort=updated"
    );
  });

  it("reads a repository's provider identity and permission flags", async () => {
    const fixture = createFixture({
      api: async (endpoint) => {
        if (endpoint === "repos/example/repo")
          return {
            id: 456,
            full_name: "example/repo",
            private: true,
            permissions: { pull: true, push: false, admin: false }
          };
        return [];
      }
    });
    await fixture.connector.connect();
    assert.deepEqual(
      await fixture.connector.readRepository({ repo: "example/repo" }),
      {
        id: "456",
        fullName: "example/repo",
        private: true,
        permissions: { pull: true, push: false, admin: false }
      }
    );
  });

  it("deduplicates authored and requested-review inbox results and reports bounded truncation", async () => {
    const fixture = createFixture({
      api: async (endpoint) => {
        if (endpoint.startsWith("search/issues?")) {
          const requested = endpoint.includes("review-requested%3A%40me");
          const page = Number(
            new URLSearchParams(endpoint.split("?")[1]).get("page")
          );
          return {
            incomplete_results: false,
            total_count: 31,
            items:
              page === 1
                ? requested
                  ? [
                      searchItem({ number: 1, author: "bob" }),
                      searchItem({ number: 2, author: "alice" })
                    ]
                  : [
                      searchItem({ number: 2, author: "alice" }),
                      searchItem({ number: 3, author: "alice" })
                    ]
                : [
                    searchItem({
                      number: 4,
                      author: requested ? "bob" : "alice"
                    })
                  ]
          };
        }
        return [];
      }
    });
    await fixture.connector.connect();
    const inbox = await fixture.connector.readInbox({ maxPages: 1 });
    assert.deepEqual(
      inbox.items.map(({ number, origin }) => [number, origin]),
      [
        [1, "requested_review"],
        [2, "authored_and_requested_review"],
        [3, "authored"]
      ]
    );
    assert.equal(inbox.truncated, true);
    assert.equal(inbox.hasMore, true);
    assert.equal(inbox.teamRequestsIncluded, false);
    assert.match(inbox.limitation, /team-review/);
  });

  it("reads detail, comments, review history, and checks with explicit bounds", async () => {
    const fixture = createFixture({
      api: async (endpoint) => {
        if (endpoint === "repos/example/repo/pulls/1") return pullRequest();
        if (endpoint.endsWith("/issues/1/comments?per_page=30&page=1"))
          return [
            {
              id: 1,
              user: { login: "bob" },
              body: "hello",
              created_at: "2026-10-01T00:00:00Z",
              html_url:
                "https://github.com/example/repo/issues/1#issuecomment-1"
            }
          ];
        if (endpoint.endsWith("/pulls/1/comments?per_page=30&page=1"))
          return [
            {
              id: 2,
              user: { login: "bob" },
              body: "inline",
              created_at: "2026-10-01T00:00:00Z",
              html_url: "https://github.com/example/repo/pull/1#discussion_r2"
            }
          ];
        if (endpoint.endsWith("/pulls/1/reviews?per_page=30&page=1"))
          return [
            {
              id: 3,
              user: { login: "bob" },
              commit_id: "a".repeat(40),
              state: "COMMENTED",
              submitted_at: "2026-10-01T00:00:00Z",
              body: "looks good",
              html_url:
                "https://github.com/example/repo/pull/1#pullrequestreview-3"
            }
          ];
        if (endpoint.endsWith("/check-runs?per_page=30&page=1"))
          return {
            total_count: 1,
            check_runs: [
              {
                id: 4,
                name: "CI",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/example/repo/actions/runs/4"
              }
            ]
          };
        return [];
      }
    });
    await fixture.connector.connect();
    const detail = await fixture.connector.readPullRequest({
      repo: "example/repo",
      number: 1
    });
    assert.equal(detail.pullRequest.headSha, "a".repeat(40));
    assert.deepEqual(detail.pullRequest.headRepository, {
      id: "2",
      fullName: "alice/repo"
    });
    assert.deepEqual(detail.pullRequest.baseRepository, {
      id: "1",
      fullName: "example/repo"
    });
    assert.equal(detail.comments[0].body, "hello");
    assert.equal(detail.reviewComments[0].body, "inline");
    assert.equal(detail.reviews[0].state, "COMMENTED");
    assert.equal(detail.checks[0].conclusion, "success");
    assert.equal(detail.commentsTruncated, false);
  });

  it("publishes only a bounded exact review after checking account and observed head, and supports reconciliation", async () => {
    let writes = 0;
    const fixture = createFixture({
      api: async (endpoint, args) => {
        if (endpoint === "repos/example/repo/pulls/1") return pullRequest();
        if (
          endpoint === "repos/example/repo/pulls/1/reviews" &&
          args.includes("POST")
        ) {
          writes += 1;
          return {
            id: 44,
            user: { login: "alice" },
            commit_id: "a".repeat(40),
            state: "APPROVED",
            submitted_at: "2026-10-01T00:00:00Z",
            body: "Approved",
            html_url:
              "https://github.com/example/repo/pull/1#pullrequestreview-44"
          };
        }
        if (endpoint === "repos/example/repo/pulls/1/reviews/44")
          return {
            id: 44,
            user: { login: "alice" },
            commit_id: "a".repeat(40),
            state: "APPROVED",
            submitted_at: "2026-10-01T00:00:00Z",
            body: "Approved",
            html_url:
              "https://github.com/example/repo/pull/1#pullrequestreview-44"
          };
        return [];
      }
    });
    await fixture.connector.connect();
    const result = await fixture.connector.publishReview({
      repo: "example/repo",
      number: 1,
      expectedHeadSha: "a".repeat(40),
      expectedAccountLogin: "alice",
      commitId: "a".repeat(40),
      event: "APPROVE",
      body: "Approved",
      comments: [
        { path: "src/file.ts", line: 7, side: "RIGHT", body: "Check this" }
      ]
    });
    assert.equal(result.review.id, 44);
    assert.equal(writes, 1);
    const write = fixture.calls.find((call) => call.args.includes("POST"));
    assert.deepEqual(write.args.slice(0, 6), [
      "api",
      "--hostname",
      "github.com",
      "repos/example/repo/pulls/1/reviews",
      "--method",
      "POST"
    ]);
    assert.deepEqual(write.args.slice(0, 7), [
      "api",
      "--hostname",
      "github.com",
      "repos/example/repo/pulls/1/reviews",
      "--method",
      "POST",
      "--input"
    ]);
    assert.equal(write.args[7], "-");
    assert.equal(JSON.parse(write.options.input).event, "APPROVE");
    assert.equal(JSON.parse(write.options.input).commit_id, "a".repeat(40));
    assert.deepEqual(JSON.parse(write.options.input).comments, [
      { path: "src/file.ts", line: 7, side: "RIGHT", body: "Check this" }
    ]);
    assert.equal(write.args.join(" ").includes("Approved"), false);
    assert.deepEqual(
      await fixture.connector.readPublishedReview({
        repo: "example/repo",
        number: 1,
        reviewId: 44
      }),
      { review: result.review, hasMore: false }
    );
    await assert.rejects(
      fixture.connector.publishReview({
        repo: "example/repo",
        number: 1,
        expectedHeadSha: "a".repeat(40),
        expectedAccountLogin: "alice",
        commitId: "a".repeat(40),
        event: "APPROVE",
        body: "x",
        comments: [{ path: "../outside", line: 1, side: "RIGHT", body: "bad" }]
      }),
      (error) => error.code === "github_invalid_review"
    );
    assert.equal(writes, 1);
  });
});
