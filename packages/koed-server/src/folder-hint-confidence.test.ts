import { describe, expect, it } from "vitest";
import {
  scoreFolderHint,
  type FolderHintInput
} from "./folder-hint-confidence.js";

const dayMs = 86_400_000;
const evaluatedAtMs = 1_750_000_000_000;
const firstConversationAtMs = evaluatedAtMs - 60 * dayMs;
const directoryStat = {
  isDirectory: true,
  birthtimeMs: firstConversationAtMs - 1,
  activityMs: evaluatedAtMs
};
const folder = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  folderId: "folder-1",
  originatingDeploymentId: "deployment-1",
  originatingDeviceId: "device-1",
  originatingProfileId: "profile-1",
  directoryIncarnationId: "incarnation-1"
};
const registry = {
  state: "matched",
  folder,
  normalizedPath: "/code/koed"
} as const;
const live: FolderHintInput = {
  effectiveFolderStatus: "unresolved",
  originalFolderReason: "missing",
  recordedMetadataState: "resolved",
  recordedCwd: "/code/koed",
  originDeviceId: "device-1",
  currentDeviceId: "device-1",
  firstConversationAtMs,
  evaluatedAtMs,
  directoryStat,
  recordedRemoteFingerprint: "remote-1",
  currentRemoteFingerprint: "remote-1",
  registry,
  hasContainedTranscriptFile: true
};
const historical: FolderHintInput = {
  ...live,
  originalFolderReason: "historical_unresolved"
};
const noActivity = { ...directoryStat, activityMs: null };
const noBirthtime = { ...directoryStat, birthtimeMs: null };
const noModerate = {
  directoryStat: noActivity,
  hasContainedTranscriptFile: false
};

describe("scoreFolderHint", () => {
  it.each<{
    name: string;
    input: FolderHintInput;
    score: number;
    tier: "none" | "medium" | "strong";
  }>([
    {
      name: "one strong and one moderate clue",
      input: {
        ...historical,
        ...noModerate,
        hasContainedTranscriptFile: true,
        currentRemoteFingerprint: null
      },
      score: 3,
      tier: "medium"
    },
    {
      name: "birthtime and remote alone (no historical registry vote)",
      input: { ...historical, ...noModerate },
      score: 4,
      tier: "medium"
    },
    {
      name: "birthtime, remote, and recent activity",
      input: { ...historical, hasContainedTranscriptFile: false },
      score: 5,
      tier: "strong"
    },
    {
      name: "birthtime, remote, and contained transcript file",
      input: { ...historical, directoryStat: noActivity },
      score: 5,
      tier: "strong"
    },
    {
      name: "birthtime, remote, and live registry",
      input: { ...live, ...noModerate },
      score: 6,
      tier: "strong"
    },
    { name: "all clues", input: live, score: 8, tier: "strong" },
    {
      name: "six points without birthtime",
      input: { ...live, directoryStat: noBirthtime },
      score: 6,
      tier: "medium"
    },
    {
      name: "six points without remote",
      input: { ...live, currentRemoteFingerprint: null },
      score: 6,
      tier: "medium"
    },
    {
      name: "two moderate clues only",
      input: {
        ...historical,
        directoryStat: noBirthtime,
        currentRemoteFingerprint: null
      },
      score: 2,
      tier: "none"
    },
    {
      name: "no clues",
      input: {
        ...historical,
        ...noModerate,
        directoryStat: { ...noActivity, birthtimeMs: null },
        currentRemoteFingerprint: null
      },
      score: 0,
      tier: "none"
    }
  ])("returns $tier at $score for $name", ({ input, score, tier }) => {
    const result = scoreFolderHint(input);
    expect(result).toMatchObject({ score, tier });
    if (tier === "none") {
      expect(result).not.toHaveProperty("folder");
      expect(result).not.toHaveProperty("project");
      expect(result).not.toHaveProperty("action");
    } else {
      expect(result).toMatchObject({ folder, action: "suggestion-only" });
    }
  });

  it.each<{
    name: string;
    overrides: Partial<FolderHintInput>;
    code: string;
    score: number;
  }>([
    {
      name: "conflicting source metadata",
      overrides: { recordedMetadataState: "conflicting" },
      code: "recorded-metadata",
      score: 8
    },
    {
      name: "missing recorded cwd",
      overrides: { recordedCwd: null },
      code: "recorded-cwd",
      score: 3
    },
    {
      name: "relative recorded cwd",
      overrides: { recordedCwd: "code/koed" },
      code: "recorded-cwd",
      score: 3
    },
    {
      name: "unprobeable cwd",
      overrides: { directoryStat: null },
      code: "local-directory",
      score: 5
    },
    {
      name: "non-directory cwd",
      overrides: { directoryStat: { ...directoryStat, isDirectory: false } },
      code: "local-directory",
      score: 5
    },
    {
      name: "different origin device",
      overrides: { originDeviceId: "device-2" },
      code: "origin-device",
      score: 6
    },
    {
      name: "birthtime after the Conversation began",
      overrides: {
        directoryStat: {
          ...directoryStat,
          birthtimeMs: firstConversationAtMs + 1
        }
      },
      code: "directory-birthtime",
      score: 6
    },
    {
      name: "different Git remotes",
      overrides: { currentRemoteFingerprint: "remote-2" },
      code: "git-remote",
      score: 6
    },
    {
      name: "ambiguous marker",
      overrides: { registry: { state: "ambiguous" } },
      code: "registry-marker-ambiguous",
      score: 6
    },
    {
      name: "missing registry candidate",
      overrides: { registry: { state: "missing" } },
      code: "registry-folder-missing",
      score: 6
    },
    {
      name: "parent registry path",
      overrides: { registry: { ...registry, normalizedPath: "/code" } },
      code: "registry-path-mismatch",
      score: 6
    },
    {
      name: "child registry path",
      overrides: {
        registry: { ...registry, normalizedPath: "/code/koed/child" }
      },
      code: "registry-path-mismatch",
      score: 6
    },
    {
      name: "registry candidate on another device",
      overrides: {
        registry: {
          ...registry,
          folder: { ...folder, originatingDeviceId: "device-2" }
        }
      },
      code: "registry-device-mismatch",
      score: 6
    },
    {
      name: "already resolved effective Folder",
      overrides: { effectiveFolderStatus: "known" },
      code: "folder-eligibility",
      score: 8
    },
    {
      name: "ineligible original Folder reason",
      overrides: { originalFolderReason: "unreliable" },
      code: "folder-eligibility",
      score: 6
    },
    {
      name: "known original Folder",
      overrides: { originalFolderReason: null },
      code: "folder-eligibility",
      score: 6
    }
  ])(
    "vetoes $name even with $score supporting points",
    ({ overrides, code, score }) => {
      const result = scoreFolderHint({ ...live, ...overrides });
      expect(result).toEqual({
        tier: "none",
        score,
        reasons: result.reasons
      });
      expect(result.reasons).toContainEqual({ code, outcome: "rejects" });
    }
  );

  it("normalizes recorded cwd before comparing it with the exact registry path", () => {
    expect(
      scoreFolderHint({ ...live, recordedCwd: "/code//other/../koed/./" })
    ).toMatchObject({ tier: "strong", score: 8, folder });
  });

  it("treats absent metadata as unavailable, not as conflicting", () => {
    const result = scoreFolderHint({
      ...live,
      recordedMetadataState: "absent",
      recordedRemoteFingerprint: null
    });
    expect(result).toMatchObject({ tier: "medium", score: 6 });
    expect(result.reasons).toContainEqual({
      code: "recorded-metadata",
      outcome: "unavailable"
    });
    expect(result.reasons).toContainEqual({
      code: "git-remote",
      outcome: "unavailable"
    });
  });

  it.each([
    {
      activityMs: evaluatedAtMs - 30 * dayMs,
      score: 5,
      tier: "strong",
      outcome: "agrees"
    },
    {
      activityMs: evaluatedAtMs - 30 * dayMs - 1,
      score: 4,
      tier: "medium",
      outcome: "does-not-agree"
    },
    {
      activityMs: evaluatedAtMs + 1,
      score: 4,
      tier: "medium",
      outcome: "does-not-agree"
    },
    {
      activityMs: Number.NaN,
      score: 4,
      tier: "medium",
      outcome: "unavailable"
    },
    {
      activityMs: Number.POSITIVE_INFINITY,
      score: 4,
      tier: "medium",
      outcome: "unavailable"
    }
  ])(
    "treats activity $activityMs as $outcome",
    ({ activityMs, score, tier, outcome }) => {
      const result = scoreFolderHint({
        ...historical,
        directoryStat: { ...directoryStat, activityMs },
        hasContainedTranscriptFile: false
      });
      expect(result).toMatchObject({ score, tier });
      expect(result.reasons).toContainEqual({
        code: "directory-activity",
        outcome
      });
    }
  );

  it.each([
    { birthtimeMs: firstConversationAtMs, outcome: "does-not-agree" },
    { birthtimeMs: Number.NaN, outcome: "unavailable" },
    { birthtimeMs: Number.POSITIVE_INFINITY, outcome: "unavailable" },
    { birthtimeMs: 0, outcome: "unavailable" },
    { birthtimeMs: -1, outcome: "unavailable" }
  ])(
    "treats birthtime $birthtimeMs as $outcome without vetoing",
    ({ birthtimeMs, outcome }) => {
      const result = scoreFolderHint({
        ...live,
        directoryStat: { ...directoryStat, birthtimeMs }
      });
      expect(result).toMatchObject({ tier: "medium", score: 6 });
      expect(result.reasons).toContainEqual({
        code: "directory-birthtime",
        outcome
      });
    }
  );

  it.each([
    {
      name: "birthtime and Conversation in the future",
      clock: evaluatedAtMs,
      birthtime: evaluatedAtMs + 1,
      first: evaluatedAtMs + 2
    },
    {
      name: "only the Conversation in the future",
      clock: evaluatedAtMs,
      birthtime: evaluatedAtMs,
      first: evaluatedAtMs + 1
    },
    {
      name: "NaN evaluation time",
      clock: Number.NaN,
      birthtime: directoryStat.birthtimeMs,
      first: firstConversationAtMs
    },
    {
      name: "infinite evaluation time",
      clock: Number.POSITIVE_INFINITY,
      birthtime: directoryStat.birthtimeMs,
      first: firstConversationAtMs
    },
    {
      name: "negative evaluation time",
      clock: -1,
      birthtime: directoryStat.birthtimeMs,
      first: firstConversationAtMs
    }
  ])(
    "does not award birthtime points with $name",
    ({ clock, birthtime, first }) => {
      const result = scoreFolderHint({
        ...historical,
        evaluatedAtMs: clock,
        firstConversationAtMs: first,
        directoryStat: { ...noActivity, birthtimeMs: birthtime }
      });
      expect(result).toMatchObject({ tier: "medium", score: 3 });
      expect(result.reasons).toContainEqual({
        code: "directory-birthtime",
        outcome: "unavailable"
      });
    }
  );

  it("awards birthtime points when the Conversation starts at evaluation time", () => {
    const result = scoreFolderHint({
      ...historical,
      firstConversationAtMs: evaluatedAtMs,
      directoryStat: noActivity
    });
    expect(result).toMatchObject({ tier: "strong", score: 5 });
  });

  it.each([evaluatedAtMs, Number.NaN])(
    "vetoes birthtime later than the Conversation with evaluation time %s",
    (clock) => {
      const result = scoreFolderHint({
        ...historical,
        evaluatedAtMs: clock,
        firstConversationAtMs: evaluatedAtMs + 1,
        directoryStat: { ...noActivity, birthtimeMs: evaluatedAtMs + 2 }
      });
      expect(result).toEqual({
        tier: "none",
        score: 3,
        reasons: result.reasons
      });
      expect(result.reasons).toContainEqual({
        code: "directory-birthtime",
        outcome: "rejects"
      });
    }
  );

  it.each([
    { currentRemoteFingerprint: "remote-1", score: 6, tier: "medium" },
    { currentRemoteFingerprint: null, score: 4, tier: "none" }
  ])(
    "with unknown origin and remote $currentRemoteFingerprint returns $tier",
    ({ currentRemoteFingerprint, score, tier }) => {
      const result = scoreFolderHint({
        ...live,
        originDeviceId: null,
        currentRemoteFingerprint
      });
      expect(result).toMatchObject({ score, tier });
      expect(result.reasons).toContainEqual({
        code: "origin-device",
        outcome: "unavailable"
      });
    }
  );

  it("vetoes later birthtime even on unknown origin", () => {
    const result = scoreFolderHint({
      ...live,
      originDeviceId: null,
      directoryStat: {
        ...directoryStat,
        birthtimeMs: firstConversationAtMs + 1
      }
    });
    expect(result).toEqual({
      tier: "none",
      score: 6,
      reasons: result.reasons
    });
    expect(result.reasons).toContainEqual({
      code: "directory-birthtime",
      outcome: "rejects"
    });
  });

  it.each(["personal", "shared", "workspace-linked"] as const)(
    "keeps %s Project context suggestion-only",
    (scope) => {
      const project = {
        scope,
        reference: { ownerUserId: folder.ownerUserId, projectId: "project-1" }
      };
      expect(scoreFolderHint({ ...live, project })).toMatchObject({
        tier: "strong",
        folder,
        project,
        action: "suggestion-only"
      });
      const wrongOwner = {
        ...project,
        reference: {
          ...project.reference,
          ownerUserId: "00000000-0000-4000-8000-000000000002"
        }
      };
      const result = scoreFolderHint({ ...live, project: wrongOwner });
      expect(result).toMatchObject({
        tier: "strong",
        folder,
        action: "suggestion-only"
      });
      expect(result).not.toHaveProperty("project");
    }
  );
});
