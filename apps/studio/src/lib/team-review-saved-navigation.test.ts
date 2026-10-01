import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native test runner needs the source extension.
import { teamReviewSavedHref } from "./team-review-saved-navigation.ts";

const input = {
  pathname: "/studio/chats",
  search: "?tab=team&teamRequestVersion=3&teamReviewVersion=4&keep=one",
  requestId: "request-1",
  teamId: "team-1",
  reviewVersion: 5
};

test("updates the review version while preserving the route and other query parameters", () => {
  assert.equal(
    teamReviewSavedHref(input),
    "/studio/chats?tab=team&teamRequestVersion=3&teamReviewVersion=5&keep=one"
  );
});

test("does not navigate when the saved version is already in the scoped URL", () => {
  assert.equal(teamReviewSavedHref({ ...input, reviewVersion: 4 }), null);
});

test("requires request and Team scope plus an existing review-version parameter", () => {
  assert.equal(teamReviewSavedHref({ ...input, requestId: null }), null);
  assert.equal(teamReviewSavedHref({ ...input, teamId: null }), null);
  assert.equal(
    teamReviewSavedHref({ ...input, search: "?tab=team&keep=one" }),
    null
  );
});
