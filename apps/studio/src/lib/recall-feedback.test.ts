import assert from "node:assert/strict";
import test from "node:test";
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { assertRecallFeedbackChange, parseRecallFeedback, parseRecallFeedbackResponse, recallFeedbackPath } from "./recall-feedback.ts";
// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { createDesktopRecallFeedbackDraftStore } from "./recall-feedback-drafts.ts";

const executionId = "11111111-1111-4111-8111-111111111111";
const answerId = "provider:22222222-2222-4222-8222-222222222222";

test("feedback path binds to a persisted provider answer and encodes its colon", () => {
  assert.equal(
    recallFeedbackPath(executionId, answerId),
    `/v1/managed-conversations/${executionId}/recall-feedback/provider%3A22222222-2222-4222-8222-222222222222`
  );
  assert.throws(() => recallFeedbackPath(executionId, "transient:item"));
  assert.throws(() => recallFeedbackPath("not-an-execution", answerId));
});

test("feedback response distinguishes no saved feedback from malformed data", () => {
  assert.equal(parseRecallFeedbackResponse({ feedback: null }), null);
  assert.deepEqual(
    parseRecallFeedbackResponse({
      feedback: {
        rating: "up",
        comment: null,
        updatedAt: "2026-10-01T10:00:00.000Z"
      }
    }),
    {
      rating: "up",
      comment: null,
      updatedAt: "2026-10-01T10:00:00.000Z"
    }
  );
  assert.throws(() => parseRecallFeedbackResponse({}));
  assert.throws(() =>
    parseRecallFeedbackResponse({ feedback: { rating: null, comment: null } })
  );
});

test("feedback rejects comments outside the 4,000 character and 16 KiB limits", () => {
  const valid = {
    rating: null,
    comment: "ok",
    updatedAt: "2026-10-01T10:00:00.000Z"
  };
  assert.deepEqual(parseRecallFeedback(valid), valid);
  assert.equal(
    parseRecallFeedback({
      ...valid,
      comment: "😀".repeat(2_100)
    }),
    null
  );
  assert.throws(() =>
    assertRecallFeedbackChange({ comment: "x".repeat(4_001) })
  );
  assert.doesNotThrow(() =>
    assertRecallFeedbackChange({ rating: "up", comment: null })
  );
  assert.throws(() => assertRecallFeedbackChange({}));
});

test("native encrypted drafts are selected only when the Desktop bridge exists", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {}
    });
    assert.equal(createDesktopRecallFeedbackDraftStore(), null);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        koedStudioChatRecovery: {
          read: async () => null,
          write: async () => undefined,
          delete: async () => undefined
        }
      }
    });
    assert.ok(createDesktopRecallFeedbackDraftStore());
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "window", original);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
