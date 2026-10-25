import type { HqOnboardingRole } from "@koed/shared/hq-onboarding-contract";

export type HqOnboardingRecord = {
  role: HqOnboardingRole;
  roleAnswered: boolean;
  completed: boolean;
  chiefName: string;
  lookSeed: string;
  lookShape: "sphere" | "roundedBox" | "cuboid" | "capsule";
  lookColor: string;
  lookTop: "none" | "antenna" | "sprout" | "ears";
  remember: boolean;
  rememberRequestId: string | null;
  noteId: string | null;
  memoryEventId: string | null;
  proposalId: string | null;
  memoryFact?: string | null;
  memoryDemoRequestId?: string | null;
  memoryDemoNoteId?: string | null;
  memoryDemoStatus?: "saved" | "pending" | "answered" | "failed" | null;
  memoryDemoAnswer?: string | null;
  memoryDemoCitations?: string[];
  hireRequestId?: string | null;
  hireAgentId?: string | null;
  hireName?: string;
  hireRole?: string;
  hireLookSeed?: string;
  hireLookColor?: string;
  stage?: 1 | 2 | 3 | 4 | 5;
};

export const initialHqOnboarding: HqOnboardingRecord = {
  role: "other",
  roleAnswered: false,
  completed: false,
  chiefName: "",
  lookSeed: "",
  lookShape: "roundedBox",
  lookColor: "#9d93fb",
  lookTop: "none",
  remember: false,
  rememberRequestId: null,
  noteId: null,
  memoryEventId: null,
  proposalId: null,
  memoryFact: null,
  memoryDemoRequestId: null,
  memoryDemoNoteId: null,
  memoryDemoStatus: null,
  memoryDemoAnswer: null,
  memoryDemoCitations: [],
  hireRequestId: null,
  hireAgentId: null,
  hireName: "Quinn",
  hireRole: "Tests",
  hireLookSeed: "onboarding-quinn",
  hireLookColor: "#5fd6a0",
  stage: 1
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
          : "#9d93fb",
      lookTop:
        value.lookTop === "antenna" ||
        value.lookTop === "sprout" ||
        value.lookTop === "ears"
          ? value.lookTop
          : "none",
      remember: value.remember === true,
      rememberRequestId:
        typeof value.rememberRequestId === "string"
          ? value.rememberRequestId
          : null,
      noteId: typeof value.noteId === "string" ? value.noteId : null,
      memoryEventId:
        typeof value.memoryEventId === "string" ? value.memoryEventId : null,
      proposalId:
        typeof value.proposalId === "string" ? value.proposalId : null,
      memoryFact:
        typeof value.memoryFact === "string" ? value.memoryFact : null,
      memoryDemoRequestId:
        typeof value.memoryDemoRequestId === "string"
          ? value.memoryDemoRequestId
          : null,
      memoryDemoNoteId:
        typeof value.memoryDemoNoteId === "string"
          ? value.memoryDemoNoteId
          : null,
      memoryDemoStatus:
        value.memoryDemoStatus === "saved" ||
        value.memoryDemoStatus === "pending" ||
        value.memoryDemoStatus === "answered" ||
        value.memoryDemoStatus === "failed"
          ? value.memoryDemoStatus
          : null,
      memoryDemoAnswer:
        typeof value.memoryDemoAnswer === "string"
          ? value.memoryDemoAnswer
          : null,
      memoryDemoCitations: Array.isArray(value.memoryDemoCitations)
        ? value.memoryDemoCitations.filter(
            (entry): entry is string => typeof entry === "string"
          )
        : [],
      hireRequestId:
        typeof value.hireRequestId === "string" ? value.hireRequestId : null,
      hireAgentId:
        typeof value.hireAgentId === "string" ? value.hireAgentId : null,
      hireName: typeof value.hireName === "string" ? value.hireName : "Quinn",
      hireRole: typeof value.hireRole === "string" ? value.hireRole : "Tests",
      hireLookSeed:
        typeof value.hireLookSeed === "string"
          ? value.hireLookSeed
          : "onboarding-quinn",
      hireLookColor:
        typeof value.hireLookColor === "string" &&
        /^#[0-9a-fA-F]{6}$/.test(value.hireLookColor)
          ? value.hireLookColor
          : "#5fd6a0",
      stage: [1, 2, 3, 4, 5].includes(value.stage ?? 0)
        ? value.stage
        : value.completed
          ? 5
          : 1
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
