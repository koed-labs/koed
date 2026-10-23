import type {
  CuratedMemoryDesktopApi,
  TeamContribution
} from "./ipc/curated-memory-protocol.js";

export const hq726ProjectId = "00000000-0000-4000-8000-000000002038";
export const hq726WorkspaceProjectId = "00000000-0000-4000-8000-000000007262";

export function createHq726ContributionsFixture(base: CuratedMemoryDesktopApi) {
  let noLongerInGroup = false;
  let holdNext = false;
  let release: (() => void) | null = null;
  const trace = { projectReads: [] as string[] };
  const contribution = (): TeamContribution => ({
    shareGrantId: "00000000-0000-4000-8000-000000007261",
    title: "Atlas summary",
    contributorDisplayName: "Bob",
    groupName: "Design Team",
    noLongerInGroup,
    summaries: [
      {
        text: "Keep the Atlas launch decision",
        title: "Atlas summary",
        occurredAt: "2026-10-20T08:00:00.000Z"
      }
    ]
  });
  const api: CuratedMemoryDesktopApi = {
    ...base,
    async teamContributions(projectId) {
      if (projectId !== hq726ProjectId)
        throw new Error("HQ-726 contribution requested for another Project.");
      trace.projectReads.push(projectId);
      const result = [contribution()];
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return structuredClone(result);
    }
  };
  const control = {
    trace,
    setNoLongerInGroup(value: boolean) {
      noLongerInGroup = value;
    },
    holdNextRead() {
      holdNext = true;
    },
    hasPendingRead() {
      return release !== null;
    },
    releasePendingRead() {
      const pending = release;
      release = null;
      pending?.();
    }
  };
  return { api, control };
}
