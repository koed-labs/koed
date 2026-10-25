import { describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import { createOnboardingMemoryDemoApi } from "./memory-demo.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const askThreadId = "22222222-2222-4222-8222-222222222222";
const questionId = "33333333-3333-4333-8333-333333333333";
const preference = "Keep answers short.";
const note = (projectionState: "pending" | "available" | "failed") => ({
  noteId,
  body: preference,
  projectionState,
  memoryEventId:
    projectionState === "available"
      ? "44444444-4444-4444-8444-444444444444"
      : null
});
const turn = (status: "pending" | "answered" | "error", id = questionId) => ({
  id,
  askThreadId,
  askTurnIndex: 0,
  query:
    "Suggest a name for the setting that controls webhook retries. Use my work preferences from retrieved Koed memory, and briefly explain how they affect your suggestion. Do not invent preferences; identify the source when available.",
  status,
  answerMarkdown: status === "answered" ? "You prefer short answers." : null,
  errorMessage: status === "error" ? "Recall failed." : null,
  createdAt: "2026-10-25T00:00:00Z",
  updatedAt: "2026-10-25T00:00:00Z",
  answeredAt: status === "answered" ? "2026-10-25T00:00:00Z" : null
});
const api = (methods: Record<string, unknown>): PersonalDesktopApi =>
  methods as unknown as PersonalDesktopApi;
const instantClock = {
  sleep: vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined)
};

describe("onboarding Memory demo", () => {
  it("returns pending when an exact Personal Note has not projected", async () => {
    const createNote = vi.fn(async () => note("pending"));
    const loadNote = vi.fn(async () => note("pending"));
    const submitAsk = vi.fn();
    const result = await createOnboardingMemoryDemoApi(
      api({ createNote, loadNote, submitAsk }),
      undefined,
      instantClock
    ).run(preference, "one");
    expect(result).toEqual({ noteId, status: "pending" });
    expect(createNote).toHaveBeenCalledWith({
      body: preference,
      idempotencyKey: "hq-onboarding-note:one"
    });
    expect(loadNote).toHaveBeenCalledTimes(4);
    expect(submitAsk).not.toHaveBeenCalled();
  });

  it("shows only a real Ask answer and keeps preference text out of the query", async () => {
    const submitAsk = vi.fn<
      (input: {
        idempotencyKey: string;
        query: string;
      }) => Promise<ReturnType<typeof turn>>
    >(async () => turn("answered"));
    const demo = createOnboardingMemoryDemoApi(
      api({
        createNote: async () => note("available"),
        submitAsk
      }),
      undefined,
      instantClock
    );
    const result = await demo.run(preference, "same-request");
    expect(result).toEqual({
      noteId,
      status: "answered",
      answer: "You prefer short answers."
    });
    expect(submitAsk.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "hq-onboarding-ask:same-request"
    });
    expect(JSON.stringify(submitAsk.mock.calls[0]?.[0])).not.toContain(
      preference
    );
    expect(result.citations).toBeUndefined();
  });

  it("does not display an answer returned for a different request", async () => {
    const demo = createOnboardingMemoryDemoApi(
      api({
        createNote: async () => note("available"),
        submitAsk: async () => ({
          ...turn("answered"),
          query: "Another request"
        })
      })
    );
    expect(await demo.run(preference, "mismatched-request")).toEqual({
      noteId,
      status: "failed",
      error: "Your AI returned a different Memory request. Try again."
    });
  });

  it("reuses stable note and Ask keys on retry", async () => {
    const createNote = vi.fn<
      (input: {
        body: string;
        idempotencyKey: string;
      }) => Promise<ReturnType<typeof note>>
    >(async () => note("available"));
    const submitAsk = vi.fn<
      (input: {
        idempotencyKey: string;
        query: string;
      }) => Promise<ReturnType<typeof turn>>
    >(async () => turn("answered"));
    const demo = createOnboardingMemoryDemoApi(
      api({ createNote, submitAsk }),
      undefined,
      instantClock
    );
    await demo.run(preference, "retry-id");
    await demo.run(preference, "retry-id");
    expect(
      new Set(createNote.mock.calls.map(([input]) => input.idempotencyKey))
    ).toEqual(new Set(["hq-onboarding-note:retry-id"]));
    expect(
      new Set(submitAsk.mock.calls.map(([input]) => input.idempotencyKey))
    ).toEqual(new Set(["hq-onboarding-ask:retry-id"]));
  });

  it("does not continue to Ask after the Personal profile changes", async () => {
    let active = true;
    const submitAsk = vi.fn();
    const demo = createOnboardingMemoryDemoApi(
      api({
        createNote: async () => {
          active = false;
          return note("available");
        },
        submitAsk
      }),
      () => active,
      instantClock
    );
    await expect(demo.run(preference, "profile-change")).rejects.toThrow(
      "profile changed"
    );
    expect(submitAsk).not.toHaveBeenCalled();
  });

  it("returns failed with the saved note ID when Ask fails", async () => {
    const demo = createOnboardingMemoryDemoApi(
      api({
        createNote: async () => note("available"),
        submitAsk: async () => {
          throw new Error("AI Client unavailable.");
        }
      }),
      undefined,
      instantClock
    );
    expect(await demo.run(preference, "ask-error")).toEqual({
      noteId,
      status: "failed",
      error: "AI Client unavailable."
    });
  });

  it("waits for the exact Ask turn and ignores another answer in the thread", async () => {
    const loadAskThread = vi
      .fn()
      .mockResolvedValueOnce([
        turn("answered", "55555555-5555-4555-8555-555555555555")
      ])
      .mockResolvedValueOnce([
        turn("answered", "55555555-5555-4555-8555-555555555555"),
        turn("answered")
      ]);
    const demo = createOnboardingMemoryDemoApi(
      api({
        createNote: async () => note("available"),
        submitAsk: async () => turn("pending"),
        loadAskThread
      }),
      undefined,
      instantClock
    );
    expect(await demo.run(preference, "pending-answer")).toEqual({
      noteId,
      status: "answered",
      answer: "You prefer short answers."
    });
    expect(loadAskThread).toHaveBeenCalledTimes(2);
  });
});
