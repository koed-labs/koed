import { useEffect, useMemo, useSyncExternalStore } from "react";
import { personalFolderScopeId } from "@koed/shared/personal-desktop";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import type { PersonalGitContext } from "@koed/shared";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PersonalMemoryStore } from "./renderer/state/personal-memory.js";
import { ProjectOrganization } from "./renderer/views/personal/ProjectOrganization.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-20T09:00:00.000Z";
const repositories: PersonalGitContext[] = Array.from(
  { length: 12 },
  (_, index) => ({
    kind: "portable_repository",
    key: `gr_transfer_${index}`,
    root: `/work/source-${index}`,
    branch: "main",
    reason: "origin",
    checkoutId: `checkout_${index}`,
    originatingDeviceId: "fixture_device",
    selectedRemote: "origin",
    anchorDisplay: `example.test/source-${index}`
  })
);
const folders = Array.from({ length: 12 }, (_, index) => ({
  reference: {
    ownerUserId: uuid(99),
    folderId: `folder-${index}`,
    originatingDeploymentId: "fixture_deployment",
    originatingDeviceId: "fixture_device",
    originatingProfileId: "fixture_profile",
    directoryIncarnationId: `directory-${index}`
  },
  normalizedPath: `/work/source-0/folder-${index}`,
  capturedPath: `/work/source-0/folder-${index}`
}));
const threads: PersonalDesktopProjectThread[] = Array.from(
  { length: 96 },
  (_, index) => ({
    id: `external-${index}`,
    name: `Conversation ${index + 1} about Project membership`,
    sessionId: uuid(1000 + index),
    sourceReferences: [
      {
        sessionId: uuid(1000 + index),
        logicalSessionId: uuid(2000 + index),
        logicalMemoryId: null
      }
    ],
    sourceAiClient: "codex",
    originDevice: { id: "fixture_device", name: "This device" },
    projectId: repositoryScopeId(repositories[0]!),
    projectName: "Koed",
    projectPath: repositories[0]!.root,
    capturedCwd: folders[Math.floor(index / 8)]!.capturedPath,
    projectAssignmentSource: "detected",
    eventCount: 1,
    invalidatedCount: 0,
    latestAt: stamp,
    sample: "",
    presentation: null
  })
);
const named: PersonalDesktopProject = {
  id: uuid(1),
  name: "Product research",
  path: null,
  eventCount: 96,
  threads,
  namedProject: {
    projectId: uuid(1),
    name: "Product research",
    version: 1,
    headRevisionId: uuid(2),
    deletedAt: null,
    createdAt: stamp,
    updatedAt: stamp
  },
  inclusionRules: repositories.map((repository, index) => ({
    inclusionId: uuid(100 + index),
    projectId: uuid(1),
    target: { kind: "repository", repository },
    version: 1,
    headRevisionId: uuid(200 + index),
    removedAt: null
  }))
};
const catalog: PersonalDesktopProject[] = [
  ...repositories.map((repository, index) => ({
    id: repositoryScopeId(repository),
    name: index === 0 ? "koed" : `Source ${index}`,
    repository,
    path: repository.root,
    eventCount: index === 0 ? 96 : 0,
    threads: index === 0 ? threads : []
  })),
  ...folders.map((folder, index) => ({
    id: personalFolderScopeId(folder.reference),
    name: index === 0 ? "API" : `Folder ${index}`,
    folder,
    path: folder.normalizedPath,
    eventCount: 8,
    threads: threads.slice(index * 8, index * 8 + 8).map((thread) => ({
      ...thread,
      folderSelection: folder.reference,
      projectId: personalFolderScopeId(folder.reference)
    }))
  })),
  named
];
const api: PersonalDesktopApi = {
  listProjects: async () => catalog,
  loadEventPage: async () => [],
  subscribe: () => () => undefined,
  updateSessionTitle: async ({ title }) => ({ title }),
  updateSessionPresentation: async () => {
    throw new Error("Read-only layout fixture");
  }
};
const manage: NonNullable<PersonalDesktopApi["manageProject"]> = async () => {
  throw new Error("Read-only layout fixture");
};
const sync: NonNullable<
  PersonalDesktopApi["manageMembershipSync"]
> = async () => ({
  state: {
    project: named.namedProject!,
    projectIdentity: named.id,
    catalog: null,
    memberships: [],
    nextEntityId: null
  }
});
export function ProjectTransferValidation() {
  const store = useMemo(() => new PersonalMemoryStore(api), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.current);
  useEffect(() => {
    void store.loadProjects().then(() => {
      document.documentElement.dataset.browserValidationReady = "true";
    });
  }, [store]);
  const projects = [...snapshot.projectsById.values()],
    project = snapshot.projectsById.get(named.id);
  return (
    <main
      className="personal-project-detail"
      style={{ maxWidth: 1000, marginInline: "auto" }}
    >
      {project ? (
        <ProjectOrganization
          project={project}
          projects={projects}
          manage={manage}
          sync={sync}
          store={store}
          onDeleted={() => undefined}
        />
      ) : null}
      <section
        data-transfer-underlay
        aria-label="Conversation inventory"
        style={{ padding: "1.25rem" }}
      >
        <h3>Conversations</h3>
        <p>{threads[0]!.name}</p>
      </section>
    </main>
  );
}
