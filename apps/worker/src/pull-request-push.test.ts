import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PullRequestReviewRecord } from "@koed/shared/pull-requests";
import { createPullRequestPushDriver } from "./pull-request-push.js";
import { pullRequestCheckoutKey } from "./pull-request-checkout.js";

const execFile = promisify(nodeExecFile);
const repository = "example/repo";
const baseUrl = `https://github.com/${repository}.git`;
const headShaPattern = /^[a-f0-9]{40}$/;
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  );
});

const git = async (cwd: string, args: string[]) => {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
};

const makeFixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "koed-pr-push-test-"));
  homes.push(home);
  const repositoryRoot = join(home, "managed-pull-requests", "sources");
  const reviewId = "11111111-1111-4111-8111-111111111111";
  const bare = join(home, "remote.git");
  const seed = join(home, "seed");
  await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
  await git(home, ["init", "--bare", bare]);
  await mkdir(seed);
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.name", "Fixture"]);
  await git(seed, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(seed, "README.md"), "initial\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "initial"]);
  const head = await git(seed, ["rev-parse", "HEAD"]);
  const checkout = join(
    repositoryRoot,
    pullRequestCheckoutKey({
      reviewId,
      repository,
      baseSha: head,
      headSha: head
    })
  );
  await git(seed, ["remote", "add", "origin", bare]);
  await git(seed, ["push", "origin", "HEAD:refs/heads/main"]);
  await git(home, ["clone", bare, checkout]);
  await git(checkout, ["remote", "set-url", "origin", baseUrl]);
  await git(checkout, ["checkout", "--detach", head]);
  const review = {
    id: reviewId,
    ownerUserId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    agentVersion: 1,
    executionId: "44444444-4444-4444-8444-444444444444",
    projectId: null,
    targetDeviceId: "device-1",
    targetDeploymentId: "deployment-1",
    account: { id: "17", login: "alice" },
    repository: {
      id: "repo-17",
      owner: "example",
      name: "repo",
      fullName: repository
    },
    pullRequestNumber: 7,
    expectedBaseSha: head,
    expectedHeadSha: head,
    connectionGeneration: 2,
    workMode: "fix",
    reviewedBaseSha: null,
    reviewedHeadSha: null,
    reviewedExecutionGeneration: 9,
    status: "active",
    revision: 3,
    draftRevision: 0,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z"
  } as PullRequestReviewRecord;
  const remote = { headSha: head, baseSha: head, pushes: 0 };
  const github = {
    async readIdentity(expectedAccountLogin: string) {
      if (typeof expectedAccountLogin !== "string")
        throw new Error("github_invalid_account");
      return { id: "17", login: expectedAccountLogin };
    },
    async readRepository({ repo }: { repo: string }) {
      if (repo !== repository) throw new Error("unexpected repository");
      return {
        id: "repo-17",
        fullName: repository,
        private: true,
        permissions: { pull: true, push: true, admin: false }
      };
    },
    async readPullRequest() {
      return {
        pullRequest: {
          number: 7,
          state: "open",
          draft: false,
          merged: false,
          author: "bob",
          baseSha: remote.baseSha,
          headSha: remote.headSha,
          headBranch: "main",
          baseBranch: "main",
          baseRepository: { id: "repo-17", fullName: repository },
          headRepository: { id: "repo-17", fullName: repository }
        }
      };
    }
  };
  const driver = createPullRequestPushDriver({
    koedHome: home,
    github: github as never
  });
  return { home, checkout, bare, head, review, remote, github, driver };
};

describe("PR push proposals", () => {
  it("freezes exact diff/tree/commit metadata without changing checkout HEAD or index", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.checkout, "README.md"), "reviewed change\n");
    const beforeHead = await git(fixture.checkout, ["rev-parse", "HEAD"]);
    const beforeIndex = await readFile(join(fixture.checkout, ".git", "index"));
    const first = await fixture.driver.preparePush(
      fixture.review,
      fixture.checkout,
      9
    );
    const second = await fixture.driver.preparePush(
      fixture.review,
      fixture.checkout,
      9
    );
    expect(first).toMatchObject({
      proposalVersion: 1,
      account: fixture.review.account,
      connectionGeneration: fixture.review.connectionGeneration,
      repository: { id: "repo-17", fullName: repository },
      headRepository: { id: "repo-17", fullName: repository },
      headBranch: "main",
      remoteSha: fixture.head,
      checkoutHead: fixture.head
    });
    expect(first.diff).toContain("reviewed change");
    expect(first.diffDigest).toBe(
      createHash("sha256").update(first.diff).digest("hex")
    );
    expect(headShaPattern.test(first.treeSha)).toBe(true);
    expect(headShaPattern.test(first.commitSha)).toBe(true);
    expect(first.commitSha).toBe(second.commitSha);
    expect(first.diffDigest).toBe(second.diffDigest);
    expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await readFile(join(fixture.checkout, ".git", "index"))).toEqual(
      beforeIndex
    );
    expect(first.executionId).toBe(fixture.review.executionId);
    expect(first.executionGeneration).toBe(9);
  });

  it("requires the verified writable head repository and current expected revisions", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.checkout, "README.md"), "change\n");
    fixture.remote.headSha = "b".repeat(40);
    await expect(
      fixture.driver.preparePush(fixture.review, fixture.checkout, 9)
    ).rejects.toThrow("PullRequestReviewOutdated");
    fixture.remote.headSha = fixture.head;
    const configPath = join(fixture.checkout, ".git", "config");
    await git(fixture.checkout, [
      "config",
      "alias.evil",
      "!touch /tmp/koed-should-not-run"
    ]);
    await expect(
      fixture.driver.preparePush(fixture.review, fixture.checkout, 9)
    ).rejects.toThrow("PullRequestCheckoutConfigUnsafe");
    expect(await lstat(configPath)).toBeDefined();
  });

  it("rejects symlinked changed files and paths outside the managed PR checkout", async () => {
    const fixture = await makeFixture();
    const outside = join(fixture.home, "outside.txt");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(fixture.checkout, "linked.txt"));
    await expect(
      fixture.driver.preparePush(fixture.review, fixture.checkout, 9)
    ).rejects.toThrow("PullRequestCheckoutUnsafe");
    await expect(
      fixture.driver.preparePush(fixture.review, resolve(fixture.home, ".."), 9)
    ).rejects.toThrow("PullRequestCheckoutUnavailable");
    expect(fixture.remote.pushes).toBe(0);
  });

  it("pushes only the confirmed fast-forward with an exact lease and reconciles by observed remote tip", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.checkout, "README.md"), "confirmed change\n");
    const proposal = await fixture.driver.preparePush(
      fixture.review,
      fixture.checkout,
      9
    );
    let pushArguments: string[] = [];
    const actualRun = async (
      binary: string,
      args: string[],
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeout: number;
        maxBuffer: number;
      }
    ) => {
      if (binary === "git" && args.includes("push")) {
        const index = args.indexOf("push");
        pushArguments = args.slice(index);
        const rewritten = pushArguments.map((argument) =>
          argument === `https://github.com/${repository}.git`
            ? fixture.bare
            : argument
        );
        const result = await execFile(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "protocol.file.allow=always",
            ...rewritten
          ],
          {
            cwd: options.cwd,
            env: {
              ...options.env,
              GIT_ALLOW_PROTOCOL: "file",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0"
            },
            encoding: "utf8",
            timeout: options.timeout,
            maxBuffer: options.maxBuffer
          }
        );
        fixture.remote.pushes += 1;
        fixture.remote.headSha = await git(fixture.bare, [
          "rev-parse",
          "refs/heads/main"
        ]);
        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      }
      const result = await execFile(binary, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: options.maxBuffer
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    };
    const driver = createPullRequestPushDriver({
      koedHome: fixture.home,
      github: fixture.github as never,
      run: actualRun
    });
    const result = await driver.push(
      fixture.review,
      proposal,
      fixture.checkout,
      9,
      async () => {}
    );
    expect(result).toMatchObject({
      pushed: true,
      commitSha: proposal.commitSha,
      diffDigest: proposal.diffDigest
    });
    expect(fixture.remote.pushes).toBe(1);
    expect(pushArguments.some((argument) => argument === "--force")).toBe(
      false
    );
    expect(pushArguments).toContain(
      `--force-with-lease=refs/heads/main:${fixture.head}`
    );
    expect(pushArguments).toContain(`${proposal.commitSha}:refs/heads/main`);
    expect(pushArguments).toContain(`https://github.com/${repository}.git`);
    expect(
      await driver.reconcilePush(fixture.review, proposal, fixture.checkout)
    ).toMatchObject({
      confirmed: true,
      proposedCommitSha: proposal.commitSha,
      remoteHeadSha: proposal.commitSha,
      diffDigest: proposal.diffDigest
    });
    expect(
      await driver.reconcilePush(
        {
          ...fixture.review,
          connectionGeneration: fixture.review.connectionGeneration + 1,
          expectedHeadSha: proposal.commitSha,
          reviewedExecutionGeneration: null
        },
        proposal,
        fixture.checkout
      )
    ).toMatchObject({ confirmed: true });
    expect(fixture.remote.pushes).toBe(1);
  });

  it("checks the runner connection fence immediately before dispatch", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.checkout, "README.md"), "confirmed change\n");
    const proposal = await fixture.driver.preparePush(
      fixture.review,
      fixture.checkout,
      9
    );
    let pushDispatches = 0;
    const run = async (
      binary: string,
      args: string[],
      options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        timeout: number;
        maxBuffer: number;
      }
    ) => {
      if (binary === "git" && args.includes("push")) {
        pushDispatches += 1;
        return { stdout: "", stderr: "" };
      }
      const result = await execFile(binary, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: options.maxBuffer
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    };
    const driver = createPullRequestPushDriver({
      koedHome: fixture.home,
      github: fixture.github as never,
      run
    });
    const fence = vi.fn(async () => {
      throw new Error("PullRequestConnectionChanged");
    });

    await expect(
      driver.push(fixture.review, proposal, fixture.checkout, 9, fence)
    ).rejects.toThrow("PullRequestConnectionChanged");

    expect(fence).toHaveBeenCalledOnce();
    expect(pushDispatches).toBe(0);
    expect(fixture.remote.pushes).toBe(0);
  });

  it("does not dispatch if the checkout diff changes after the proposal", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.checkout, "README.md"), "confirmed change\n");
    const proposal = await fixture.driver.preparePush(
      fixture.review,
      fixture.checkout,
      9
    );
    await writeFile(
      join(fixture.checkout, "README.md"),
      "changed after confirmation\n"
    );
    await expect(
      fixture.driver.push(
        fixture.review,
        proposal,
        fixture.checkout,
        9,
        async () => {}
      )
    ).rejects.toThrow("PullRequestPushProposalChanged");
    expect(fixture.remote.pushes).toBe(0);
  });
});
