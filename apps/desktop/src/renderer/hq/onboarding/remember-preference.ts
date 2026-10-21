import { hqOnboardingPreferenceClaim } from "@koed/shared/hq-onboarding-contract";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { CuratedMemoryDesktopApi } from "../../../ipc/curated-memory-protocol.js";
import type { HqOnboardingRecord } from "./onboarding-preference.js";

export type RememberPreferenceResult =
  | { kind: "proposal"; record: HqOnboardingRecord }
  | { kind: "reviewed"; record: HqOnboardingRecord }
  | { kind: "projection_pending"; record: HqOnboardingRecord };

/** Every network step has a persisted checkpoint so a lost response can retry safely. */
export async function rememberHqPreference(input: {
  record: HqOnboardingRecord;
  personalMemoryApi: PersonalDesktopApi;
  curatedMemoryApi: CuratedMemoryDesktopApi;
  save: (value: HqOnboardingRecord) => void;
  current: () => boolean;
}): Promise<RememberPreferenceResult> {
  if (!input.record.remember || !input.record.rememberRequestId)
    throw new Error("Choose Remember before saving this preference to Me.");
  if (!input.personalMemoryApi.createNote)
    throw new Error("Personal Notes are unavailable.");
  if (!input.curatedMemoryApi.proposeOnboardingPreference)
    throw new Error("Curated Memory review is unavailable.");
  const claim = hqOnboardingPreferenceClaim(input.record.role);
  let record = input.record;
  if (!record.noteId || !record.memoryEventId) {
    const note = await input.personalMemoryApi.createNote({
      body: claim,
      idempotencyKey: `hq-onboarding-preference:${record.rememberRequestId}`
    });
    if (!input.current()) throw new Error("Personal profile changed.");
    if (note.body !== claim)
      throw new Error("Personal Note retry returned different content.");
    record = {
      ...record,
      noteId: note.noteId,
      memoryEventId: note.memoryEventId
    };
    input.save(record);
  }
  if (!record.memoryEventId) return { kind: "projection_pending", record };
  if (!record.proposalId) {
    const proposal = await input.curatedMemoryApi.proposeOnboardingPreference({
      role: record.role,
      noteId: record.noteId!,
      memoryEventId: record.memoryEventId
    });
    if (!input.current()) throw new Error("Personal profile changed.");
    if (proposal.status === "conflicted" || proposal.status === "skipped")
      throw new Error(
        "Your AI Client did not store this preference proposal. Review it in Me memory."
      );
    record = { ...record, proposalId: proposal.proposalId };
    input.save(record);
    if (proposal.status !== "pending") return { kind: "reviewed", record };
  }
  return { kind: "proposal", record };
}
