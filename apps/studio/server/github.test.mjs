import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createGithubConnector } from "./github.mjs";
import { startStudioServer } from "./index.mjs";

const githubResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const httpRequest = (url, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text,
          json: () => JSON.parse(text)
        });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

describe("GitHub connector", () => {
  let started;

  afterEach(async () => {
    await started?.close?.();
    started = undefined;
  });

  it("uses fixed gh arguments and keeps the token out of its status DTO", async () => {
    const calls = [];
    const connector = createGithubConnector({
      execFile: async (...args) => {
        calls.push(args);
        return { stdout: "ghs-test-secret\n" };
      },
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://api.github.com/user");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.authorization, "Bearer ghs-test-secret");
        return githubResponse({ login: "octocat" });
      }
    });

    assert.deepEqual(await connector.connect(), {
      state: "connected",
      login: "octocat",
      message: null,
      capabilities: { readPullRequests: true, publishReviews: false }
    });
    assert.deepEqual(calls[0]?.slice(0, 2), [
      "gh",
      ["auth", "token", "--hostname", "github.com"]
    ]);
    assert.equal(
      JSON.stringify(connector.getStatus()).includes("secret"),
      false
    );
  });

  it("does not let a late connect win after disconnect", async () => {
    let releaseToken;
    const tokenReady = new Promise((resolve) => {
      releaseToken = resolve;
    });
    const connector = createGithubConnector({
      execFile: async () => {
        await tokenReady;
        return { stdout: "ghs-race-secret" };
      },
      fetchImpl: async () => githubResponse({ login: "late-user" })
    });

    const connecting = connector.connect();
    assert.deepEqual(connector.disconnect().state, "disconnected");
    releaseToken();
    await connecting;
    assert.equal(connector.getStatus().state, "disconnected");
    assert.equal(connector.getStatus().login, null);
  });

  it("sanitizes gh failures", async () => {
    const connector = createGithubConnector({
      execFile: async () => {
        const error = new Error("ghs-never-return-this");
        error.stderr = "ghs-never-return-this";
        throw error;
      },
      fetchImpl: async () => githubResponse({ login: "unexpected" })
    });
    const status = await connector.connect();
    assert.equal(status.state, "error");
    assert.equal(status.login, null);
    assert.equal(status.message.includes("ghs-never-return-this"), false);
  });

  it("rejects provider redirects and does not expose provider errors", async () => {
    let requestOptions;
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async (_url, options) => {
        requestOptions = options;
        throw new TypeError("redirected with fixture-token");
      }
    });
    const status = await connector.connect();
    assert.equal(requestOptions.redirect, "error");
    assert.equal(status.state, "error");
    assert.equal(status.message, "GitHub identity check failed.");
    assert.equal(JSON.stringify(status).includes("fixture-token"), false);
  });

  it("rejects malformed and oversized identity responses", async () => {
    for (const body of ["not-json", "x".repeat(70 * 1024)]) {
      const connector = createGithubConnector({
        execFile: async () => ({ stdout: "fixture-token" }),
        fetchImpl: async () => new Response(body, { status: 200 })
      });
      const status = await connector.connect();
      assert.equal(status.state, "error");
      assert.equal(status.login, null);
      assert.equal(JSON.stringify(status).includes("fixture-token"), false);
    }
  });

  it("requires origin-scoped CSRF and an empty JSON object for writes", async () => {
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "ghs-http-secret" }),
      fetchImpl: async () => githubResponse({ login: "octocat" })
    });
    started = await startStudioServer({
      port: 0,
      staticDir: "/tmp/koed-studio-missing-static",
      githubConnector: connector
    });
    const origin = started.url;
    const session = await httpRequest(`${origin}/studio-api/github/session`, {
      headers: { origin }
    });
    assert.equal(session.status, 200);
    const csrf = session.json().csrfToken;
    assert.equal(typeof csrf, "string");

    const missingCsrf = await httpRequest(
      `${origin}/studio-api/github/connect`,
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "content-length": "2"
        },
        body: "{}"
      }
    );
    assert.equal(missingCsrf.status, 403);

    const wrongOrigin = await httpRequest(
      `${origin}/studio-api/github/connect`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost:1",
          "x-studio-csrf": csrf,
          "content-type": "application/json",
          "content-length": "2"
        },
        body: "{}"
      }
    );
    assert.equal(wrongOrigin.status, 403);

    const wrongBody = await httpRequest(`${origin}/studio-api/github/connect`, {
      method: "POST",
      headers: {
        origin,
        "x-studio-csrf": csrf,
        "content-type": "application/json",
        "content-length": "13"
      },
      body: '{"extra":true}'
    });
    assert.equal(wrongBody.status, 400);

    const connected = await httpRequest(`${origin}/studio-api/github/connect`, {
      method: "POST",
      headers: {
        origin,
        "x-studio-csrf": csrf,
        "content-type": "application/json",
        "content-length": "2"
      },
      body: "{}"
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.json().login, "octocat");
    assert.equal(JSON.stringify(connected.json()).includes("secret"), false);
  });

  it("rejects missing and cross-origin browser credentials", async () => {
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async () => githubResponse({ login: "octocat" })
    });
    started = await startStudioServer({
      port: 0,
      staticDir: "/tmp/koed-studio-missing-static",
      githubConnector: connector
    });
    const origin = started.url;
    const session = await httpRequest(`${origin}/studio-api/github/session`, {
      headers: { origin }
    });
    const csrf = session.json().csrfToken;
    const missingOrigin = await httpRequest(
      `${origin}/studio-api/github/connect`,
      {
        method: "POST",
        headers: {
          "x-studio-csrf": csrf,
          "content-type": "application/json",
          "content-length": "2"
        },
        body: "{}"
      }
    );
    assert.equal(missingOrigin.status, 403);
    const crossOriginStatus = await httpRequest(
      `${origin}/studio-api/github/status`,
      {
        headers: { origin: "http://localhost:1" }
      }
    );
    assert.equal(crossOriginStatus.status, 403);
    const crossOriginSession = await httpRequest(
      `${origin}/studio-api/github/session`,
      {
        headers: { origin: "http://localhost:1" }
      }
    );
    assert.equal(crossOriginSession.status, 403);
  });

  it("expires CSRF sessions", async () => {
    let clock = 1_000;
    started = await startStudioServer({
      port: 0,
      staticDir: "/tmp/koed-studio-missing-static",
      now: () => new Date(clock),
      githubSessionTtlMs: 10,
      githubConnector: createGithubConnector({
        execFile: async () => ({ stdout: "fixture-token" }),
        fetchImpl: async () => githubResponse({ login: "octocat" })
      })
    });
    const origin = started.url;
    const session = await httpRequest(`${origin}/studio-api/github/session`, {
      headers: { origin }
    });
    clock += 11;
    const response = await httpRequest(
      `${origin}/studio-api/github/disconnect`,
      {
        method: "POST",
        headers: {
          origin,
          "x-studio-csrf": session.json().csrfToken,
          "content-type": "application/json",
          "content-length": "2"
        },
        body: "{}"
      }
    );
    assert.equal(response.status, 403);
  });

  it("lets a newer connect win when an older request finishes late", async () => {
    let call = 0;
    let releaseFirst;
    const firstFetch = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const connector = createGithubConnector({
      execFile: async () => ({
        stdout: ++call === 1 ? "token-one" : "token-two"
      }),
      fetchImpl: async (_url, options) => {
        if (options.headers.authorization === "Bearer token-one") {
          await firstFetch;
          return githubResponse({ login: "older" });
        }
        return githubResponse({ login: "newer" });
      }
    });
    const older = connector.connect();
    await new Promise((resolve) => setImmediate(resolve));
    const newer = connector.connect();
    assert.equal((await newer).login, "newer");
    releaseFirst();
    await older;
    assert.equal(connector.getStatus().login, "newer");
  });

  it("refreshes identity before reads and maps fixed GitHub responses", async () => {
    const requests = [];
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async (url, options) => {
        requests.push([url, options]);
        if (url === "https://api.github.com/user")
          return githubResponse({ login: "octocat" });
        if (url.includes("/user/repos"))
          return githubResponse([
            { id: 1, full_name: "octocat/hello", private: true }
          ]);
        if (url.includes("/pulls/7"))
          return githubResponse({
            number: 7,
            title: "Fix",
            state: "closed",
            draft: false,
            merged_at: "2026-09-22T00:00:00Z",
            user: { login: "octocat" },
            requested_reviewers: [{ login: "reviewer" }],
            head: { sha: "head", ref: "fix" },
            base: { sha: "base", ref: "main" },
            updated_at: "2026-09-22T00:00:00Z",
            html_url: "https://github.com/octocat/hello/pull/7",
            body: "body",
            additions: 2,
            deletions: 1,
            changed_files: 1
          });
        return githubResponse([]);
      }
    });
    await connector.connect();
    assert.deepEqual(await connector.readRepositories(), {
      repositories: [{ id: 1, fullName: "octocat/hello", private: true }],
      hasMore: false,
      page: 1
    });
    const detail = await connector.readPullRequest({
      repo: "octocat/hello",
      number: 7
    });
    assert.equal(detail.pullRequest.merged, true);
    assert.equal(detail.pullRequest.bodyTruncated, false);
    assert.equal(detail.pullRequest.changedFiles, 1);
    const readRequest = requests.at(-1);
    assert.equal(
      readRequest[0],
      "https://api.github.com/repos/octocat/hello/pulls/7"
    );
    assert.equal(readRequest[1].redirect, "error");
  });

  it("fails closed when refreshed GitHub identity changes", async () => {
    let identityChecks = 0;
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async (url) => {
        if (url === "https://api.github.com/user")
          return githubResponse({
            login: identityChecks++ === 0 ? "octocat" : "other"
          });
        throw new Error("should-not-read");
      }
    });
    await connector.connect();
    await assert.rejects(
      connector.readRepositories(),
      (error) => error.message === "github_account_changed"
    );
    assert.equal(connector.getStatus().state, "error");
  });

  it("rejects unsafe repositories and malformed pull request payloads", async () => {
    const connector = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async (url) => {
        if (url.endsWith("/user")) return githubResponse({ login: "octocat" });
        return githubResponse([{}]);
      }
    });
    await connector.connect();
    await assert.rejects(
      connector.readPullRequests({ repo: "../secret" }),
      (error) => error.message === "github_invalid_repository"
    );
    await assert.rejects(
      connector.readPullRequests({ repo: "octocat/hello" }),
      (error) => error.message === "github_read_invalid"
    );
  });

  it("invalidates a connected status after credential rejection but not rate limits", async () => {
    let tokenCalls = 0;
    const rejected = createGithubConnector({
      execFile: async () => {
        if (tokenCalls++ === 0) return { stdout: "fixture-token" };
        throw new Error("credential rejected");
      },
      fetchImpl: async () => githubResponse({ login: "octocat" })
    });
    await rejected.connect();
    await assert.rejects(rejected.readRepositories());
    assert.equal(rejected.getStatus().state, "error");

    let requestCount = 0;
    const rateLimited = createGithubConnector({
      execFile: async () => ({ stdout: "fixture-token" }),
      fetchImpl: async (url) => {
        if (url.endsWith("/user")) return githubResponse({ login: "octocat" });
        requestCount += 1;
        return new Response("{}", {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0"
          }
        });
      }
    });
    await rateLimited.connect();
    await assert.rejects(
      rateLimited.readRepositories(),
      (error) => error.message === "github_rate_limited"
    );
    assert.equal(requestCount, 1);
    assert.equal(rateLimited.getStatus().state, "connected");
  });

  it("signals lost authentication distinctly from temporary read failures", async () => {
    let failure;
    started = await startStudioServer({
      port: 0,
      githubConnector: {
        readRepositories: async () => {
          throw new Error(failure);
        }
      }
    });
    for (const [code, expected] of [
      ["github_identity_rejected", 401],
      ["github_cli_auth_failed", 401],
      ["github_account_changed", 409],
      ["github_rate_limited", 429],
      ["github_identity_timeout", 504]
    ]) {
      failure = code;
      const response = await httpRequest(
        `${started.url}/studio-api/github/repositories?page=1`
      );
      assert.equal(response.status, expected, code);
    }
  });

  it("rejects query arguments on connector endpoints", async () => {
    started = await startStudioServer({
      port: 0,
      staticDir: "/tmp/koed-studio-missing-static",
      githubConnector: createGithubConnector()
    });
    const response = await httpRequest(
      `${started.url}/studio-api/github/status?token=do-not-use`
    );
    assert.equal(response.status, 400);
  });

  it("serves bounded read-only repository and pull request routes", async () => {
    const calls = [];
    const githubConnector = {
      getStatus: () => ({
        state: "connected",
        login: "octocat",
        message: null,
        capabilities: { readPullRequests: true, publishReviews: false }
      }),
      readRepositories: async (query) => {
        calls.push(["repositories", query]);
        return {
          repositories: [{ id: 1, fullName: "octocat/hello", private: false }],
          hasMore: false,
          page: 2
        };
      },
      readPullRequests: async (query) => {
        calls.push(["pulls", query]);
        return {
          pullRequests: [],
          hasMore: false,
          page: 1
        };
      },
      readPullRequest: async (query) => {
        calls.push(["pull", query]);
        return {
          pullRequest: {
            number: 7,
            title: "Fix",
            state: "open",
            draft: false,
            merged: false,
            author: "octocat",
            requestedReviewers: [],
            headSha: "head",
            baseSha: "base",
            headBranch: "fix",
            baseBranch: "main",
            updatedAt: "2026-09-22T00:00:00Z",
            url: "https://github.com/octocat/hello/pull/7",
            body: "body",
            additions: 1,
            deletions: 1,
            changedFiles: 1
          }
        };
      }
    };
    started = await startStudioServer({
      port: 0,
      staticDir: "/tmp/koed-studio-missing-static",
      githubConnector
    });
    const repositories = await httpRequest(
      `${started.url}/studio-api/github/repositories?page=2`
    );
    assert.equal(repositories.status, 200);
    assert.equal(repositories.json().repositories[0].fullName, "octocat/hello");
    const pulls = await httpRequest(
      `${started.url}/studio-api/github/pulls?repo=octocat%2Fhello`
    );
    assert.equal(pulls.status, 200);
    const pull = await httpRequest(
      `${started.url}/studio-api/github/pull?repo=octocat%2Fhello&number=7`
    );
    assert.equal(pull.status, 200);
    assert.deepEqual(calls, [
      ["repositories", { page: "2" }],
      ["pulls", { repo: "octocat/hello", page: "1" }],
      ["pull", { repo: "octocat/hello", number: "7" }]
    ]);
    const arbitrary = await httpRequest(
      `${started.url}/studio-api/github/pulls?repo=octocat%2Fhello&url=https%3A%2F%2Fevil.example`
    );
    assert.equal(arbitrary.status, 400);
  });
});
