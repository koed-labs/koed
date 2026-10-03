import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { StudioNotificationNavigation } from "@koed/shared/studio-notifications";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { findAuthorizedStudioNotificationDestination } from "./studio-notification-destination.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const rootMessageId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";

const snapshot = {
  navigation: {
    teams: [
      {
        id: teamId,
        channels: [{ id: threadId }],
        sharedProjects: [],
        directMessages: []
      }
    ]
  }
} as unknown as CollaborationSnapshot;

const navigation: StudioNotificationNavigation = {
  kind: "team_thread",
  teamId,
  threadId,
  rootMessageId,
  messageId
};

test("notification destination opens an authorized thread without an attention-feed item", () => {
  assert.deepEqual(
    findAuthorizedStudioNotificationDestination(snapshot, navigation),
    { teamId, threadId, rootMessageId }
  );
});

test("notification destination fails closed when current Team authority lacks the Team or thread", () => {
  assert.equal(
    findAuthorizedStudioNotificationDestination(
      { navigation: { teams: [] } } as unknown as CollaborationSnapshot,
      navigation
    ),
    null
  );
  assert.equal(
    findAuthorizedStudioNotificationDestination(
      {
        navigation: {
          teams: [
            { id: teamId, channels: [], sharedProjects: [], directMessages: [] }
          ]
        }
      } as unknown as CollaborationSnapshot,
      navigation
    ),
    null
  );
});
