import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import * as attention from "./studio-attention.ts";
import type { HomeViewItem } from "./studio-home";

const item = (
  id: string,
  urgency: HomeViewItem["urgency"],
  detail = "Current details"
): HomeViewItem => ({
  id,
  title: id,
  detail,
  kicker: "Agent review",
  action: "Review",
  urgency,
  projectId: null,
  destination: { type: "agent-review", executionId: id },
  disabledReason: ""
});

test("maps the Home urgency scale to attention tiers", () => {
  assert.equal(attention.studioAttentionTier("now"), "blocking");
  assert.equal(attention.studioAttentionTier("soon"), "waiting");
  assert.equal(attention.studioAttentionTier("idle"), "fyi");
});

test("scopes persisted clears to an authorized snapshot identity", () => {
  assert.equal(attention.studioAttentionStorageKey(null), null);
  assert.equal(
    attention.studioAttentionStorageKey("user:one"),
    "koed.studio.home.cleared.v1:user%3Aone"
  );
  assert.deepEqual(
    attention.parseStudioClearedAttention({ a: "signature", bad: 42 }),
    {
      a: "signature"
    }
  );
});

test("clearing hides an unchanged item, newer visible data returns it, and restore works", () => {
  const first = item("run-1", "now");
  const cleared = attention.clearStudioAttentionItem(first, {});
  assert.deepEqual(attention.partitionStudioAttention([first], cleared), {
    visible: [],
    cleared: [first]
  });

  const changed = item("run-1", "now", "New failure detail");
  assert.deepEqual(attention.partitionStudioAttention([changed], cleared), {
    visible: [changed],
    cleared: []
  });
  assert.deepEqual(
    attention.partitionStudioAttention(
      [first],
      attention.restoreStudioAttentionItem(first.id, cleared)
    ),
    { visible: [first], cleared: [] }
  );
});

test("orders actions by attention tier while retaining source order within a tier", () => {
  const items = [
    item("info", "idle"),
    item("waiting", "soon"),
    item("blocked", "now")
  ];
  assert.deepEqual(
    attention
      .partitionStudioAttention(items, {})
      .visible.map((entry) => entry.id),
    ["blocked", "waiting", "info"]
  );
});
