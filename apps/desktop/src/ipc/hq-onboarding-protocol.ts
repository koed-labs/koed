export type HqOnboardingDriver = "codex" | "claude" | "pi";

export type HqOnboardingIdentity = {
  profileKey: string;
  ownerId: string | null;
};

export type HqOnboardingClient = {
  driver: HqOnboardingDriver;
  name: string;
  installed: boolean;
  authenticated: "yes" | "no" | "unknown";
  selected: boolean;
  configured: boolean;
  memoryConnected: boolean;
  error: string | null;
};

export type HqOnboardingStatus = {
  profileKey: string;
  memoryState: "not_started" | "preparing" | "ready" | "failed";
  ownerId: string | null;
  error: string | null;
  clients: HqOnboardingClient[];
  progress?: {
    message: string;
    completedSteps: number;
    totalSteps: number;
    startedAt: number;
  } | null;
};
