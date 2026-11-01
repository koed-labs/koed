import { describe, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import { saveOnboardingMemory } from "./memory.js";

describe("onboarding memory", () => {
  it("uses a stable key after a lost response and does not claim pending memory is recallable", async () => {
    const createNote = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({ projectionState: "pending" });
    const api = { createNote } as unknown as PersonalDesktopApi;
    await expect(
      saveOnboardingMemory(api, "Keep answers short")
    ).rejects.toThrow("connection lost");
    const result = await saveOnboardingMemory(api, "Keep answers short");
    expect(createNote.mock.calls[0]).toEqual(createNote.mock.calls[1]);
    expect(result.message).toContain("preparing");
    expect(result.message).not.toContain("Available");
  });
  it("surfaces failed preparation rather than claiming a successful demo", async () => {
    const api = {
      createNote: vi.fn().mockResolvedValue({ projectionState: "failed" })
    } as unknown as PersonalDesktopApi;
    await expect(saveOnboardingMemory(api, "A preference")).rejects.toThrow(
      "preparation needs attention"
    );
  });
});
