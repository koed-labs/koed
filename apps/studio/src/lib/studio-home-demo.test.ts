import assert from "node:assert/strict";
import test from "node:test";
// Node 24's native TypeScript runner requires the source extension here.
// prettier-ignore
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { DEMO_HOME_ITEMS, INITIAL_DEMO_STATE, demoReducer, demoItemsForProject, demoItemsForState } from "./studio-home-demo.ts";

test("demo feed contains each supported workflow destination", () => {
  assert.deepEqual(
    DEMO_HOME_ITEMS.slice(0, 5).map((item) => item.demoDestination.type),
    ["briefing", "chat", "collaboration", "decision", "review"]
  );
  assert.deepEqual(
    DEMO_HOME_ITEMS.slice(5).map((item) => item.id),
    ["demo-briefing-reference", "demo-review-reference"]
  );
  assert.ok(DEMO_HOME_ITEMS.slice(5).every((item) => item.urgency === "idle"));
  assert.ok(DEMO_HOME_ITEMS.every((item) => item.actionLabel.length > 0));
});

test("demo project filtering is stable and does not mutate the feed", () => {
  const filtered = demoItemsForProject("data-migration");
  assert.deepEqual(
    filtered.map((item) => item.id),
    ["demo-chat", "demo-decision", "demo-review", "demo-review-reference"]
  );
  assert.equal(demoItemsForProject(null).length, 7);
});

test("demo reducer preserves local replies and decisions across navigation", () => {
  let state = demoReducer(INITIAL_DEMO_STATE, {
    type: "send-chat",
    text: "Use the checkpoint table"
  });
  state = demoReducer(state, {
    type: "reply-collaboration",
    text: "I will carry both keys through the transition."
  });
  state = demoReducer(state, { type: "decide", decision: "approved" });
  state = demoReducer(state, {
    type: "open",
    screen: { type: "briefing", id: "briefing-auth" }
  });

  assert.deepEqual(state.chatMessages, ["Use the checkpoint table"]);
  assert.deepEqual(state.collaborationReplies, [
    "I will carry both keys through the transition."
  ]);
  assert.equal(state.decision, "approved");
  assert.deepEqual(state.screen, {
    type: "briefing",
    id: "briefing-auth"
  });
});

test("reset clears all simulated state", () => {
  const changed = demoReducer(
    {
      ...INITIAL_DEMO_STATE,
      chatMessages: ["local message"],
      decision: "changes-requested"
    },
    { type: "reset" }
  );
  assert.deepEqual(changed, INITIAL_DEMO_STATE);
});

test("completed local decisions are reflected on Home without changing destinations", () => {
  const state = demoReducer(INITIAL_DEMO_STATE, {
    type: "decide",
    decision: "approved"
  });
  const item = demoItemsForState(state, "data-migration").find(
    (candidate) => candidate.id === "demo-decision"
  );
  assert.equal(item?.title, "Backfill approved");
  assert.equal(item?.actionLabel, "View decision");
  assert.equal(item?.urgency, "idle");
  assert.deepEqual(item?.demoDestination, {
    type: "decision",
    id: "decision-index"
  });
});
