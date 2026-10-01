import assert from "node:assert/strict";
import test from "node:test";
import {
  activeChatExchange,
  chatNavigationMessages,
  chatNavigationPreview,
  isChatNavigationCompact,
  type SharedChatMessage
  // @ts-expect-error Node's test runner resolves the explicit extension; tsconfig does not permit TS extensions.
} from "../lib/shared-chat-model.ts";

const messages: SharedChatMessage[] = [
  { id: "viewer-1", role: "user", content: "First prompt" },
  { id: "answer-1", role: "assistant", content: "A long reply" },
  {
    id: "viewer-2",
    role: "user",
    authoredByViewer: false,
    content: "Someone else's message"
  },
  {
    id: "viewer-3",
    role: "assistant",
    authoredByViewer: true,
    content: "My Team message"
  },
  {
    id: "answer-3",
    role: "assistant",
    content: "A reply taller than the viewport"
  }
];

test("uses explicit viewer authorship for human messages", () => {
  assert.deepEqual(
    chatNavigationMessages(messages).map((message) => message.id),
    ["viewer-1", "viewer-3"]
  );
});

test("keeps the current viewer exchange active through a long assistant reply", () => {
  assert.equal(activeChatExchange(messages, "answer-3"), "viewer-3");
  assert.equal(activeChatExchange(messages, "viewer-1"), "viewer-1");
  assert.equal(activeChatExchange(messages, "missing"), null);
});

test("keeps previews plain text and bounded", () => {
  const preview = chatNavigationPreview("  <b>literal</b>\n" + "x".repeat(500));
  assert.equal(preview.length, 160);
  assert.ok(preview.includes("<b>literal</b>"));
});

test("hides the rail based on chat container width", () => {
  assert.equal(isChatNavigationCompact(599), true);
  assert.equal(isChatNavigationCompact(600), false);
  assert.equal(isChatNavigationCompact(420), true);
});

test("retains message identity when streaming content changes", () => {
  const streamed = messages.map((message) =>
    message.id === "answer-3"
      ? { ...message, content: `${message.content}…more` }
      : message
  );
  assert.deepEqual(
    chatNavigationMessages(streamed).map((message) => message.id),
    ["viewer-1", "viewer-3"]
  );
  assert.equal(activeChatExchange(streamed, "answer-3"), "viewer-3");
});
