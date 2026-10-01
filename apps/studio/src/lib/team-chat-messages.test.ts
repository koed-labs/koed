import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationMessage } from "@koed/shared/collaboration";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { toTeamChatMessages } from "./team-chat-messages.ts";

function message(id: string, senderId: string, body: string) {
  return Object.freeze({
    id,
    sender: Object.freeze({
      id: senderId,
      displayName: `Name for ${senderId}`
    }),
    body
  }) as CollaborationMessage;
}

test("team message mapping scopes explicit viewer authorship to the viewer", () => {
  const first = message("message-1", "user-1", "Hello");
  const second = message("message-2", "user-2", "Hi");
  const messages = Object.freeze([first, second]);

  const forFirstViewer = toTeamChatMessages(messages, "user-1");
  const forSecondViewer = toTeamChatMessages(messages, "user-2");

  assert.deepEqual(
    forFirstViewer.map(({ id, role, authoredByViewer }) => ({
      id,
      role,
      authoredByViewer
    })),
    [
      { id: "message-1", role: "user", authoredByViewer: true },
      { id: "message-2", role: "assistant", authoredByViewer: false }
    ]
  );
  assert.deepEqual(
    forSecondViewer.map(({ role, authoredByViewer }) => ({
      role,
      authoredByViewer
    })),
    [
      { role: "assistant", authoredByViewer: false },
      { role: "user", authoredByViewer: true }
    ]
  );
});

test("team message mapping preserves IDs, content, author names, and source references", () => {
  const source = message("message-3", "user-3", "A body");
  const [mapped] = toTeamChatMessages([source], "another-user");

  assert.equal(mapped?.id, "message-3");
  assert.equal(mapped?.content, "A body");
  assert.deepEqual(mapped?.author, { name: "Name for user-3" });
  assert.equal(mapped?.source, source);
});

test("team message mapping does not mutate its frozen input", () => {
  const source = message("message-4", "user-4", "Unchanged");
  const messages = Object.freeze([source]);
  const before = structuredClone(messages);

  toTeamChatMessages(messages, "user-4");

  assert.deepEqual(messages, before);
  assert.equal(source.body, "Unchanged");
});
