import { mkdtemp, mkdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  preparePullRequestCheckout,
  pullRequestProcessEnvironment
} from "./pull-request-checkout.js";
const head = "a".repeat(40),
  base = "b".repeat(40);
const scope = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  repository: "koed-labs/fixture",
  number: 2,
  accountLogin: "alice",
  headSha: head,
  baseSha: base
};
describe("PR checkout pinning", () => {
  it("rejects a changed remote head before cloning", async () => {
    let invoked = false;
    await expect(
      preparePullRequestCheckout({
        koedHome: tmpdir(),
        scope,
        observe: async () => ({ ...scope, headSha: "c".repeat(40) }),
        run: async () => {
          invoked = true;
          return { stdout: "", stderr: "" };
        }
      })
    ).rejects.toThrow("PullRequestScopeStale");
    expect(invoked).toBe(false);
  });
  it("pins both observations, disables hooks and leaves Project paths untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "koed-pr-checkout-test-"));
    const commands: string[][] = [];
    let reads = 0;
    try {
      const path = await preparePullRequestCheckout({
        koedHome: home,
        scope,
        observe: async () => {
          reads++;
          return scope;
        },
        run: async (binary, args, options) => {
          commands.push([binary, ...args]);
          expect(options.env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
          if (binary === "gh" && args[0] === "repo")
            await mkdir(args[3]!, { recursive: true });
          return {
            stdout: args.includes("rev-parse")
              ? `${head}\n`
              : args.includes("get-url")
                ? `https://github.com/${scope.repository}.git\n`
                : "",
            stderr: ""
          };
        }
      });
      expect(path.startsWith(await realpath(home))).toBe(true);
      expect(reads).toBe(2);
      expect(commands.some((args) => args.includes(`${base}^{commit}`))).toBe(
        true
      );
      expect(commands.some((args) => args.includes("--detach"))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("rejects a symlinked checkout root", async () => {
    const home = await mkdtemp(join(tmpdir(), "koed-pr-link-test-"));
    try {
      await mkdir(join(home, "managed-pull-requests"));
      await symlink(tmpdir(), join(home, "managed-pull-requests", "sources"));
      await expect(
        preparePullRequestCheckout({
          koedHome: home,
          scope,
          observe: async () => scope
        })
      ).rejects.toThrow("PullRequestCheckoutRootInvalid");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("does not inherit ambient GitHub tokens or Git overrides", () => {
    const prior = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "fixture-secret";
    try {
      expect(pullRequestProcessEnvironment().GH_TOKEN).toBeUndefined();
      expect(pullRequestProcessEnvironment().GIT_SSH_COMMAND).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prior;
    }
  });
});
