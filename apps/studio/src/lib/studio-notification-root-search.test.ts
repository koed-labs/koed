import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationMessagePage } from "@koed/shared/collaboration";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { findStudioNotificationRoot } from "./studio-notification-root-search.ts";

const page = (
  root: boolean,
  olderCursor: string | null
): CollaborationMessagePage => ({
  snapshotRevision: "0",
  olderCursor,
  newerCursor: null,
  hasOlder: olderCursor !== null,
  hasNewer: false,
  threadId: "22222222-2222-4222-8222-222222222222",
  rootMessageId: null,
  items: root
    ? [
        {
          id: "55555555-5555-4555-8555-555555555555",
          threadId: "22222222-2222-4222-8222-222222222222",
          scope: "team",
          teamId: "11111111-1111-4111-8111-111111111111",
          sequence: 1,
          sender: {
            id: "33333333-3333-4333-8333-333333333333",
            displayName: "Member",
            membershipState: "enabled"
          },
          senderKind: "user",
          body: "Private message text stays in the model only",
          createdAt: "2026-10-02T10:00:00.000Z",
          updatedAt: "2026-10-02T10:00:00.000Z",
          rootMessageId: null,
          version: 1,
          replyCount: 0,
          unreadReplyCount: 0,
          mentionUserIds: [],
          reactions: [],
          editedAt: null,
          deletedAt: null,
          delivery: "sent",
          recipientStatus: null,
          failure: null
        }
      ]
    : []
});

test("notification navigation opens a root on the current message page", async () => {
  const cursors: Array<[string, string | null]> = [];
  const result = await findStudioNotificationRoot(
    "55555555-5555-4555-8555-555555555555",
    async (direction, cursor) => {
      cursors.push([direction, cursor]);
      return page(true, null);
    }
  );
  assert.equal(result?.id, "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(cursors, [["newer", null]]);
});

test("notification navigation finds an older root through authenticated page cursors", async () => {
  const cursors: Array<[string, string | null]> = [];
  const result = await findStudioNotificationRoot(
    "55555555-5555-4555-8555-555555555555",
    async (direction, cursor) => {
      cursors.push([direction, cursor]);
      return cursor === null ? page(false, "older-1") : page(true, null);
    }
  );
  assert.equal(result?.id, "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(cursors, [
    ["newer", null],
    ["older", "older-1"]
  ]);
});
