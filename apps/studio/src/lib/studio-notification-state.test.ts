import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldEmitStudioNotification,
  studioNotificationDedupeKey,
  trimStudioNotificationSeen
  // @ts-expect-error -- Node's native TypeScript runner requires the source extension.
} from "./studio-notification-state.ts";
import type { StudioNotificationIntent } from "@koed/shared/studio-notifications";

const teamIntent = (
  sourceRevision: string,
  messageId: string
): StudioNotificationIntent => ({
  version: 1,
  source: "team_overview",
  accountScope: "opaque-team-scope",
  backendId: "backend-a",
  sourceEventId: "dm:thread-a",
  sourceRevision,
  messageId
});
const homeIntent: StudioNotificationIntent = {
  version: 1,
  source: "home",
  accountScope: "opaque-home-scope",
  backendId: null,
  sourceEventId: "runtime:item-1",
  sourceRevision: "r1"
};

test("Studio notification deduplication does not replay old messages when a grouped DM revision changes", () => {
  const seen = new Set<string>();
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      teamIntent("g1", "message-a"),
      "direct_message",
      {
        reseed: true,
        occurredAt: "2026-10-02T10:00:00.000Z"
      }
    ),
    false
  );
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      teamIntent("g2", "message-a"),
      "direct_message",
      {
        reseed: false,
        occurredAt: "2026-10-02T10:00:00.000Z",
        after: "2026-10-02T09:59:59.000Z"
      }
    ),
    false
  );
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      teamIntent("g2", "message-b"),
      "direct_message",
      {
        reseed: false,
        occurredAt: "2026-10-02T10:00:01.000Z",
        after: "2026-10-02T10:00:00.500Z"
      }
    ),
    true
  );
});

test("Studio notifications keep owner scopes separate without evicting a valid oversized baseline", () => {
  const first = teamIntent("g1", "message-a");
  const otherScope = { ...first, accountScope: "different-opaque-scope" };
  assert.notEqual(
    studioNotificationDedupeKey(first, "mention"),
    studioNotificationDedupeKey(otherScope, "mention")
  );
  const seen = new Set(
    Array.from({ length: 700 }, (_, index) => String(index))
  );
  trimStudioNotificationSeen(seen, 1_600);
  assert.equal(seen.size, 700);
  seen.add("bounded");
  trimStudioNotificationSeen(seen, 1_600);
  assert.equal(seen.size, 701);
  assert.equal(seen.has("0"), true);
  assert.equal(seen.has("bounded"), true);
});

test("Studio notifications silently seed history and ignore older page turns", () => {
  const seen = new Set<string>();
  const baseline = Array.from({ length: 700 }, (_, index) =>
    teamIntent("g1", `message-${index}`)
  );
  for (const intent of baseline) {
    assert.equal(
      shouldEmitStudioNotification(seen, intent, "direct_message", {
        reseed: true,
        occurredAt: "2026-10-02T09:00:00.000Z"
      }),
      false
    );
  }
  assert.equal(seen.size, 700);
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      teamIntent("g2", "message-699"),
      "direct_message",
      {
        reseed: false,
        occurredAt: "2026-10-02T09:00:00.000Z",
        after: "2026-10-02T10:00:00.000Z"
      }
    ),
    false
  );
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      teamIntent("g3", "message-new"),
      "direct_message",
      {
        reseed: false,
        occurredAt: "2026-10-02T10:00:01.000Z",
        after: "2026-10-02T10:00:00.000Z"
      }
    ),
    true
  );
});

test("an old Home item entering the bounded window is not emitted as new", () => {
  const seen = new Set<string>();
  assert.equal(
    shouldEmitStudioNotification(seen, homeIntent, "agent_input", {
      reseed: false,
      occurredAt: "2026-10-02T09:00:00.000Z",
      after: "2026-10-02T10:00:00.000Z"
    }),
    false
  );
  assert.equal(
    shouldEmitStudioNotification(
      seen,
      {
        ...homeIntent,
        sourceEventId: "runtime:item-2",
        sourceRevision: "r1"
      },
      "agent_input",
      {
        reseed: false,
        occurredAt: "2026-10-02T10:00:01.000Z",
        after: "2026-10-02T10:00:00.000Z"
      }
    ),
    true
  );
});
