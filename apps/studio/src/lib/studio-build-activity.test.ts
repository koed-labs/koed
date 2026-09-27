import test from "node:test";
import assert from "node:assert/strict";
// Node 24's native TypeScript runner requires the source extension here.
// prettier-ignore
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { createEmptyBuildActivity, observedBuildTotals, storyEvents, technicalEvents, type BuildActivity } from "./studio-build-activity.ts";

test("empty activity stays honest about unknown progress and totals", () => {
  const activity = createEmptyBuildActivity("live");
  assert.equal(activity.state, "unknown");
  assert.deepEqual(observedBuildTotals(activity), {
    filesChanged: null,
    additions: null,
    deletions: null
  });
});

test("story and advanced views select the same reported events", () => {
  const activity: BuildActivity = {
    source: "live",
    state: "completed",
    events: [
      { id: "story", kind: "message", story: { title: "Ready" } },
      {
        id: "technical",
        kind: "file-change",
        technical: {
          files: [{ path: "src/app.ts", change: "modified" }],
          diff: { filesChanged: 1, additions: 4, deletions: 2 }
        }
      }
    ]
  };
  assert.deepEqual(
    storyEvents(activity).map((event) => event.id),
    ["story"]
  );
  assert.deepEqual(
    technicalEvents(activity).map((event) => event.id),
    ["technical"]
  );
  assert.deepEqual(observedBuildTotals(activity), {
    filesChanged: 1,
    additions: 4,
    deletions: 2
  });
});

test("latest explicitly reported totals win without inventing missing fields", () => {
  const activity: BuildActivity = {
    source: "live",
    state: "running",
    events: [
      { id: "one", kind: "file-change", technical: { diff: { additions: 3 } } },
      { id: "two", kind: "progress", technical: { diff: { additions: 5 } } }
    ]
  };
  assert.deepEqual(observedBuildTotals(activity), {
    filesChanged: null,
    additions: 5,
    deletions: null
  });
});
