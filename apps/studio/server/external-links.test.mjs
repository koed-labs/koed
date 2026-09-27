import { test } from "node:test";
import assert from "node:assert/strict";
import { isGithubPullRequestUrl } from "../main/external-links.cjs";

test("desktop external links allow only HTTPS GitHub PR pages", () => {
  assert.equal(
    isGithubPullRequestUrl("https://github.com/koed-labs/koed/pull/123"),
    true
  );
  for (const url of [
    "http://github.com/koed-labs/koed/pull/123",
    "https://github.com.evil.test/koed-labs/koed/pull/123",
    "https://github.com:444/koed-labs/koed/pull/123",
    "https://token@github.com/koed-labs/koed/pull/123",
    "https://github.com/login",
    "https://github.com/koed-labs/koed/pull/123?redirect=elsewhere",
    "file:///tmp/example",
    "javascript:alert(1)",
    "invalid"
  ])
    assert.equal(isGithubPullRequestUrl(url), false, url);
});
