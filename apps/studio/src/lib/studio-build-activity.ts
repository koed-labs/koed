/**
 * Observed build activity supplied by a real execution producer or by the
 * explicitly labelled Studio demo. The UI must not infer file or diff data
 * from conversation text.
 */
export type BuildActivitySource = "live" | "demo" | "none";

export type BuildActivityState =
  | "unknown"
  | "idle"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export type BuildActivityEventKind =
  | "started"
  | "progress"
  | "file-change"
  | "command"
  | "completed"
  | "blocked"
  | "failed"
  | "message"
  | "input-required"
  | "workspace-observed"
  | "phase";

export type BuildActivityJob = {
  id: string;
  title: string;
  state: BuildActivityState;
  createdAt?: string;
};

export type BuildFileChange = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number;
  deletions?: number;
  baseline?: boolean;
  patch?: string;
  confirmation?: "applied" | "recorded";
  patchTruncated?: boolean;
  patchUnavailable?: string;
};

export type BuildActivityEvent = {
  id: string;
  at?: number;
  kind: BuildActivityEventKind;
  state?: BuildActivityState;
  story?: {
    title: string;
    detail?: string;
    outcome?: string;
  };
  technical?: {
    execution?: {
      client: string;
      model: string;
      reasoning: string | null;
      access: string;
    };
    branch?: string;
    status?: string;
    command?: string;
    result?: string;
    files?: BuildFileChange[];
    diff?: {
      filesChanged?: number;
      additions?: number;
      deletions?: number;
    };
  };
  attention?: {
    runtimeItemId: string;
    kind: "user_input" | "command_approval";
  };
};

export type BuildActivity = {
  source: BuildActivitySource;
  state: BuildActivityState;
  project?: {
    name?: string;
    branch?: string;
    status?: string;
  };
  events: BuildActivityEvent[];
  recentExchanges?: BuildActivityEvent[];
  recentTurnChanges?: BuildActivityEvent;
  updatedAt?: number;
  jobs?: BuildActivityJob[];
  selectedJobId?: string;
  availability?: "available" | "unavailable" | "no_project";
};

export type ObservedBuildTotals = {
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
};

export function createEmptyBuildActivity(
  source: BuildActivitySource = "none"
): BuildActivity {
  return { source, state: "unknown", events: [] };
}

export function storyEvents(activity: BuildActivity | null | undefined) {
  return activity?.events.filter((event) => event.story) ?? [];
}

export function technicalEvents(activity: BuildActivity | null | undefined) {
  return activity?.events.filter((event) => event.technical) ?? [];
}

/**
 * Totals only values explicitly reported by the producer. A missing field is
 * kept as null so a clean repository or a chat reply cannot be presented as
 * proof that work was saved or that a diff exists.
 */
export function observedBuildTotals(
  activity: BuildActivity | null | undefined
): ObservedBuildTotals {
  const events = technicalEvents(activity);
  const values = {
    filesChanged: events
      .map((event) => event.technical?.diff?.filesChanged)
      .filter((value): value is number => Number.isFinite(value)),
    additions: events
      .map((event) => event.technical?.diff?.additions)
      .filter((value): value is number => Number.isFinite(value)),
    deletions: events
      .map((event) => event.technical?.diff?.deletions)
      .filter((value): value is number => Number.isFinite(value))
  };
  return {
    filesChanged: values.filesChanged.length
      ? values.filesChanged[values.filesChanged.length - 1]
      : null,
    additions: values.additions.length
      ? values.additions[values.additions.length - 1]
      : null,
    deletions: values.deletions.length
      ? values.deletions[values.deletions.length - 1]
      : null
  };
}

export function activityStateLabel(state: BuildActivityState) {
  switch (state) {
    case "running":
      return "In progress";
    case "completed":
      return "Completed";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export const DEMO_BUILD_ACTIVITY: BuildActivity = {
  source: "demo",
  state: "completed",
  project: {
    name: "Data migration",
    branch: "migration/backfill-index",
    status: "clean (observed)"
  },
  events: [
    {
      id: "demo-plan",
      at: 1710000000000,
      kind: "progress",
      state: "running",
      story: {
        title: "Mapped the rollback path",
        detail:
          "The local simulation identified the checkpoint that must be restored before cutover.",
        outcome: "Rollback checkpoint documented"
      },
      technical: {
        branch: "migration/backfill-index",
        status: "clean (observed)",
        files: [
          {
            path: "rollback/checkpoint.sql",
            change: "modified",
            additions: 2,
            deletions: 1
          }
        ],
        diff: { filesChanged: 1, additions: 2, deletions: 1 }
      }
    },
    {
      id: "demo-verify",
      at: 1710000060000,
      kind: "completed",
      state: "completed",
      story: {
        title: "Finished the dry run",
        detail:
          "The simulated migration completed its verification checklist with one warning to review.",
        outcome: "Dry run complete"
      },
      technical: {
        branch: "migration/backfill-index",
        status: "clean (observed)",
        files: [
          {
            path: "migrations/backfill.sql",
            change: "added",
            additions: 18,
            deletions: 0
          },
          {
            path: "rollback/checkpoint.sql",
            change: "modified",
            additions: 2,
            deletions: 1
          }
        ],
        diff: { filesChanged: 2, additions: 20, deletions: 1 }
      }
    }
  ],
  updatedAt: 1710000060000
};

export const DEMO_STANDALONE_BUILD_ACTIVITY: BuildActivity = {
  source: "demo",
  state: "completed",
  events: [
    {
      id: "demo-standalone-plan",
      at: 1710000000000,
      kind: "progress",
      state: "completed",
      story: {
        title: "Prepared a local example",
        detail:
          "This sample activity demonstrates the Build panel without attaching the chat to a project.",
        outcome: "Example ready"
      },
      technical: {
        status: "Reported by demo simulation",
        files: [
          {
            path: "example/plan.txt",
            change: "added",
            additions: 4,
            deletions: 0
          }
        ],
        diff: { filesChanged: 1, additions: 4, deletions: 0 }
      }
    }
  ],
  updatedAt: 1710000000000
};
