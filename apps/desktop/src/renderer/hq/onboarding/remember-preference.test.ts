// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { CuratedMemoryDesktopApi } from "../../../ipc/curated-memory-protocol.js";
import {
  hqOnboardingStorageKey,
  initialHqOnboarding,
  readHqOnboarding,
  writeHqOnboarding,
  type HqOnboardingRecord
} from "./onboarding-preference.js";
import { rememberHqPreference } from "./remember-preference.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const proposalId = "33333333-3333-4333-8333-333333333333";

describe("HQ role preference", () => {
  beforeEach(() => localStorage.clear());

  it("keeps defaults isolated by owner and stable profile across transport reconnects", () => {
    const record = { ...initialHqOnboarding, role: "studying" as const };
    expect(
      writeHqOnboarding("owner-a", "owner-a|epoch-1|backend-a", record)
    ).toBe(true);
    expect(readHqOnboarding("owner-a", "owner-a|epoch-2|backend-a").role).toBe(
      "studying"
    );
    expect(readHqOnboarding("owner-b", "owner-b|epoch-2|backend-a").role).toBe(
      "other"
    );
    expect(readHqOnboarding("owner-a", "owner-a|epoch-2|backend-b").role).toBe(
      "other"
    );
    expect(hqOnboardingStorageKey("owner-a", "owner-a|epoch-1|backend-a")).toBe(
      hqOnboardingStorageKey("owner-a", "owner-a|epoch-2|backend-a")
    );
  });

  it("requires Remember consent and checkpoints Note before idempotent proposal retry", async () => {
    const createNote = vi.fn().mockResolvedValue({
      noteId,
      memoryEventId: eventId,
      body: "I mostly use Koed for studying."
    });
    const proposeOnboardingPreference = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary disconnect"))
      .mockResolvedValue({
        proposalId,
        status: "pending",
        reviewedAssertionId: null
      });
    const personalMemoryApi = { createNote } as unknown as PersonalDesktopApi;
    const curatedMemoryApi = {
      proposeOnboardingPreference
    } as unknown as CuratedMemoryDesktopApi;
    let saved: HqOnboardingRecord = {
      ...initialHqOnboarding,
      role: "studying"
    };
    const save = (record: HqOnboardingRecord) => {
      saved = record;
    };
    const invoke = () =>
      rememberHqPreference({
        record: saved,
        personalMemoryApi,
        curatedMemoryApi,
        save,
        current: () => true
      });
    await expect(invoke()).rejects.toThrow("Choose Remember");
    expect(createNote).not.toHaveBeenCalled();
    saved = { ...saved, remember: true, rememberRequestId: "stable-request" };
    await expect(invoke()).rejects.toThrow("temporary disconnect");
    expect(saved).toMatchObject({ noteId, memoryEventId: eventId });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(createNote).toHaveBeenCalledWith({
      body: "I mostly use Koed for studying.",
      idempotencyKey: "hq-onboarding-preference:stable-request"
    });
    await expect(invoke()).resolves.toMatchObject({ kind: "proposal" });
    await expect(invoke()).resolves.toMatchObject({ kind: "proposal" });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(proposeOnboardingPreference).toHaveBeenCalledTimes(2);
    expect(saved.proposalId).toBe(proposalId);
  });

  it("does not save a Note response after the owner profile switches", async () => {
    const createNote = vi.fn().mockResolvedValue({
      noteId,
      memoryEventId: eventId,
      body: "I mostly use Koed for studying."
    });
    const save = vi.fn();
    const proposeOnboardingPreference = vi.fn();
    await expect(
      rememberHqPreference({
        record: {
          ...initialHqOnboarding,
          role: "studying",
          remember: true,
          rememberRequestId: "stable-request"
        },
        personalMemoryApi: { createNote } as unknown as PersonalDesktopApi,
        curatedMemoryApi: {
          proposeOnboardingPreference
        } as unknown as CuratedMemoryDesktopApi,
        save,
        current: () => false
      })
    ).rejects.toThrow("Personal profile changed");
    expect(save).not.toHaveBeenCalled();
    expect(proposeOnboardingPreference).not.toHaveBeenCalled();
  });

  it("reports a completed or skipped review honestly on an exact retry", async () => {
    const record = {
      ...initialHqOnboarding,
      role: "studying" as const,
      remember: true,
      rememberRequestId: "reviewed-retry",
      noteId,
      memoryEventId: eventId
    };
    const save = vi.fn();
    const proposeOnboardingPreference = vi
      .fn()
      .mockResolvedValueOnce({
        proposalId,
        status: "stored",
        reviewedAssertionId: proposalId
      })
      .mockResolvedValueOnce({
        proposalId,
        status: "skipped",
        reviewedAssertionId: null
      });
    const createNote = vi.fn();
    const invokeWithNote = () =>
      rememberHqPreference({
        record,
        save,
        current: () => true,
        personalMemoryApi: { createNote } as unknown as PersonalDesktopApi,
        curatedMemoryApi: {
          proposeOnboardingPreference
        } as unknown as CuratedMemoryDesktopApi
      });
    await expect(invokeWithNote()).resolves.toMatchObject({ kind: "reviewed" });
    await expect(invokeWithNote()).rejects.toThrow(
      "did not store this preference"
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(createNote).not.toHaveBeenCalled();
  });
});
