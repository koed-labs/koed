import { useEffect, useMemo } from "react";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import type { Project } from "@koed/shared";
import type { ProjectsDesktopApi } from "./ipc/projects-protocol.js";
import { HqApplication } from "./renderer/hq/HqApplication.js";
import { PersonalMemoryStore } from "./renderer/state/personal-memory.js";

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const sessionId = "40000000-0000-4000-8000-000000000001";
const ownerId = "50000000-0000-4000-8000-000000000001";
const now = "2026-10-20T10:00:00.000Z";

const project = (id: string, name: string, key: string): Project => ({
  id,
  name,
  key,
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
});
const first = project(firstId, "Atlas", "atlas");
const second = project(secondId, "Studio", "studio");
let placement: string | null = firstId;

const thread = (): PersonalDesktopProjectThread => ({
  id: "hq107-local-thread",
  name: "Sprint planning",
  sessionId,
  sourceAiClient: "codex-cli",
  projectId: placement ?? "lp_chats",
  personalProjectId: placement,
  projectName:
    placement === firstId
      ? first.name
      : placement === secondId
        ? second.name
        : "Chats",
  projectPath: null,
  projectAssignmentSource: "user_override",
  eventCount: 3,
  invalidatedCount: 0,
  latestAt: now,
  sample: "Plan the next sprint.",
  presentation: null
});
const desktopProjects = (): PersonalDesktopProject[] => [
  {
    id: firstId,
    name: first.name,
    path: null,
    eventCount: 3,
    threads: placement === firstId ? [thread()] : []
  },
  {
    id: secondId,
    name: second.name,
    path: null,
    eventCount: 3,
    threads: placement === secondId ? [thread()] : []
  },
  {
    id: "lp_chats",
    name: "Chats",
    path: null,
    eventCount: 3,
    threads: placement === null ? [thread()] : []
  }
];

const api: PersonalDesktopApi = {
  listProjects: async () => desktopProjects(),
  loadEventPage: async () => [],
  assignSessionProject: async (input) => {
    if (
      input.expectedProjectId !== undefined &&
      input.expectedProjectId !== placement
    )
      throw new Error("Conversation placement changed");
    if (input.action === "undo_move")
      throw new Error("Unexpected shared move Undo in private fixture");
    placement = input.action === "move" ? input.targetProjectId : null;
    return { projectId: placement };
  },
  updateSessionTitle: async ({ title }) => ({ title }),
  updateSessionPresentation: async () => ({
    presentation: {
      pinnedAt: null,
      displayMode: "automatic",
      snoozedAt: null,
      snoozedUntil: null,
      version: 1,
      updatedAt: now
    }
  }),
  subscribe: () => () => undefined
};
const projectsApi = { list: async () => [first, second] } as ProjectsDesktopApi;

export const Hq107ValidationApp = () => {
  const store = useMemo(() => new PersonalMemoryStore(api), []);
  useEffect(() => {
    document.documentElement.dataset.hq107FixtureReady = "true";
  }, []);
  return (
    <HqApplication
      personalMemoryReady
      personalMemoryStore={store}
      personalMemoryApi={api}
      projectsApi={projectsApi}
      visibilityOwnerId={ownerId}
      visibilityProfileKey="hq107-isolated"
    />
  );
};
