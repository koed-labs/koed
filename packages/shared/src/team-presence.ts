export const teamPresenceModes = ["auto", "manual"] as const;
export type TeamPresenceMode = (typeof teamPresenceModes)[number];

export const teamManualStatuses = [
  "available",
  "do_not_disturb",
  "out_of_office"
] as const;
export type TeamManualStatus = (typeof teamManualStatuses)[number];
export type TeamManualStatusDisplay = TeamManualStatus | "unknown";

export const TEAM_PRESENCE_STATUS_CATALOGUE_VERSION = 1;

export interface TeamPresenceStatusCatalogue {
  version: number;
  statuses: Array<{
    key: TeamManualStatus;
    label: string;
  }>;
}

export const teamPresenceStatusCatalogue: TeamPresenceStatusCatalogue = {
  version: TEAM_PRESENCE_STATUS_CATALOGUE_VERSION,
  statuses: [
    { key: "available", label: "Available" },
    { key: "do_not_disturb", label: "Do not disturb" },
    { key: "out_of_office", label: "Out of office" }
  ]
};

export const isTeamManualStatus = (value: string): value is TeamManualStatus =>
  teamManualStatuses.some((status) => status === value);

export const teamActivityLevels = [
  "active",
  "recently_active",
  "idle",
  "inactive"
] as const;
export type TeamActivityLevel = (typeof teamActivityLevels)[number];

export const TEAM_ACTIVITY_ACTIVE_MS = 5 * 60 * 1000;
export const TEAM_ACTIVITY_RECENT_MS = 30 * 60 * 1000;
export const TEAM_ACTIVITY_IDLE_MS = 2 * 60 * 60 * 1000;
export const TEAM_ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000;

export interface TeamPresenceSnapshot {
  mode: TeamPresenceMode;
  manualStatus: TeamManualStatusDisplay;
  activityLevel: TeamActivityLevel | null;
  lastActivityAt: string | null;
  nextTransitionAt: string | null;
  preferenceVersion: number;
}

export const deriveTeamPresenceSnapshot = (
  input: {
    mode: TeamPresenceMode;
    manualStatus: TeamManualStatusDisplay;
    lastActivityAt: string | null;
    preferenceVersion: number;
  },
  nowMs = Date.now()
): TeamPresenceSnapshot => {
  if (input.mode === "manual") {
    return {
      mode: input.mode,
      manualStatus: input.manualStatus,
      activityLevel: null,
      lastActivityAt: null,
      nextTransitionAt: null,
      preferenceVersion: input.preferenceVersion
    };
  }

  const activityMs = input.lastActivityAt
    ? Date.parse(input.lastActivityAt)
    : Number.NaN;
  if (!Number.isFinite(activityMs) || activityMs > nowMs) {
    return {
      mode: input.mode,
      manualStatus: input.manualStatus,
      activityLevel: "inactive",
      lastActivityAt: input.lastActivityAt,
      nextTransitionAt: null,
      preferenceVersion: input.preferenceVersion
    };
  }

  const elapsedMs = nowMs - activityMs;
  const activityLevel =
    elapsedMs <= TEAM_ACTIVITY_ACTIVE_MS
      ? "active"
      : elapsedMs <= TEAM_ACTIVITY_RECENT_MS
        ? "recently_active"
        : elapsedMs <= TEAM_ACTIVITY_IDLE_MS
          ? "idle"
          : "inactive";
  const transitionOffset =
    activityLevel === "active"
      ? TEAM_ACTIVITY_ACTIVE_MS
      : activityLevel === "recently_active"
        ? TEAM_ACTIVITY_RECENT_MS
        : activityLevel === "idle"
          ? TEAM_ACTIVITY_IDLE_MS
          : null;

  return {
    mode: input.mode,
    manualStatus: input.manualStatus,
    activityLevel,
    lastActivityAt: new Date(activityMs).toISOString(),
    nextTransitionAt:
      transitionOffset === null
        ? null
        : new Date(activityMs + transitionOffset + 1).toISOString(),
    preferenceVersion: input.preferenceVersion
  };
};

export const coarsePresenceFromTeamPresence = (
  presence: TeamPresenceSnapshot
): "available" | "away" | "offline" => {
  if (presence.mode === "manual") {
    return presence.manualStatus === "available" ? "available" : "away";
  }
  return presence.activityLevel === "active"
    ? "available"
    : presence.activityLevel === "inactive"
      ? "offline"
      : "away";
};
