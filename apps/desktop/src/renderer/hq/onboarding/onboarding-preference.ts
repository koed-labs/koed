import type { HqOnboardingRole } from "@koed/shared/hq-onboarding-contract";

export type HqOnboardingRecord = {
  role: HqOnboardingRole;
  roleAnswered: boolean;
  completed: boolean;
  chiefName: string;
  lookSeed: string;
  lookShape: "sphere" | "roundedBox" | "cuboid" | "capsule";
  lookColor: string;
  remember: boolean;
  rememberRequestId: string | null;
  noteId: string | null;
  memoryEventId: string | null;
  proposalId: string | null;
};

export const initialHqOnboarding: HqOnboardingRecord = {
  role: "other",
  roleAnswered: false,
  completed: false,
  chiefName: "",
  lookSeed: "",
  lookShape: "roundedBox",
  lookColor: "#8c76d7",
  remember: false,
  rememberRequestId: null,
  noteId: null,
  memoryEventId: null,
  proposalId: null
};

export const hqSuggestedProjectName = (role: HqOnboardingRole): string =>
  role === "software"
    ? "My software project"
    : role === "studying"
      ? "My course"
      : "My project";

/** connectedAt is an ephemeral transport epoch, not the saved profile. */
export function hqOnboardingStorageKey(
  ownerId: string,
  profileKey: string
): string {
  const first = profileKey.indexOf("|");
  const second = first < 0 ? -1 : profileKey.indexOf("|", first + 1);
  const stableProfile =
    second < 0
      ? profileKey
      : `${profileKey.slice(0, first)}|${profileKey.slice(second + 1)}`;
  return `koed.hq.onboarding.v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(stableProfile)}`;
}

export function readHqOnboarding(
  ownerId: string,
  profileKey: string
): HqOnboardingRecord {
  try {
    const value = JSON.parse(
      localStorage.getItem(hqOnboardingStorageKey(ownerId, profileKey)) ??
        "null"
    ) as Partial<HqOnboardingRecord> | null;
    if (!value || !["software", "studying", "other"].includes(value.role ?? ""))
      return initialHqOnboarding;
    return {
      role: value.role!,
      roleAnswered: value.roleAnswered === true,
      completed: value.completed === true,
      chiefName: typeof value.chiefName === "string" ? value.chiefName : "",
      lookSeed: typeof value.lookSeed === "string" ? value.lookSeed : "",
      lookShape:
        value.lookShape === "sphere" ||
        value.lookShape === "roundedBox" ||
        value.lookShape === "cuboid" ||
        value.lookShape === "capsule"
          ? value.lookShape
          : "roundedBox",
      lookColor:
        typeof value.lookColor === "string" &&
        /^#[0-9a-fA-F]{6}$/.test(value.lookColor)
          ? value.lookColor
          : "#8c76d7",
      remember: value.remember === true,
      rememberRequestId:
        typeof value.rememberRequestId === "string"
          ? value.rememberRequestId
          : null,
      noteId: typeof value.noteId === "string" ? value.noteId : null,
      memoryEventId:
        typeof value.memoryEventId === "string" ? value.memoryEventId : null,
      proposalId: typeof value.proposalId === "string" ? value.proposalId : null
    };
  } catch {
    return initialHqOnboarding;
  }
}

export function writeHqOnboarding(
  ownerId: string,
  profileKey: string,
  value: HqOnboardingRecord
): boolean {
  try {
    localStorage.setItem(
      hqOnboardingStorageKey(ownerId, profileKey),
      JSON.stringify(value)
    );
    return true;
  } catch {
    return false;
  }
}
