import { useEffect } from "react";
import { PersonalMemoryWorkspace } from "./renderer/views/personal/PersonalMemoryViews.js";
import { PersonalMemoryStore } from "./renderer/state/personal-memory.js";
import type { ProjectSelectionCommandResult } from "@koed/shared/project-selection";
import { mergeProjectSources } from "./project-memory-ui.js";
import type { RendererPlatform } from "./renderer/services/platform.js";

const repository = {
  kind: "portable_repository" as const,
  key: "gr_folder_fixture",
  root: "/private/operator/koed",
  branch: "main",
  reason: "origin" as const,
  checkoutId: "checkout_one",
  originatingDeviceId: "fixture_device",
  selectedRemote: "origin",
  anchorDisplay: "github.com/koed-labs/koed"
};
const metadata = ["koed", "koed-alt"].map((name, index) => ({
  schemaVersion: 1 as const,
  discoveredAt: "2026-10-16T00:00:00.000Z",
  lastSeenAt: "2026-10-16T00:00:00.000Z",
  localProjectId: `lp_${String(index + 1).repeat(32)}`,
  displayName: "koed",
  path: {
    cwd: `/private/operator/${name}`,
    projectRoot: `/private/operator/${name}`
  },
  git: {
    branch: "main",
    isWorktree: false,
    remotes: [
      {
        name: index ? "upstream" : "origin",
        display: repository.anchorDisplay
      }
    ]
  },
  repository: {
    ...repository,
    root: `/private/operator/${name}`,
    checkoutId: `checkout_${index + 1}`,
    selectedRemote: index ? "upstream" : "origin"
  }
}));
const project = mergeProjectSources([], metadata)[0]!;
project.threads = project.checkouts!.map((folder, index) => ({
  id: `folder-conversation-${index + 1}`,
  name: `Conversation in ${index ? "koed-alt" : "koed"}`,
  sessionId: null,
  sourceAiClient: "codex" as const,
  projectId: project.id,
  projectName: project.name,
  projectPath: folder.path,
  capturedCwd: folder.path,
  projectAssignmentSource: "detected" as const,
  repositoryAssignment: {
    state: "recorded" as const,
    version: 1,
    automatic: folder.repository!,
    override: null,
    effective: folder.repository!
  },
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: new Date().toISOString(),
  sample: "Folder filter fixture",
  presentation: null
}));
const trace: unknown[] = [];
Object.assign(window, { projectFolderValidationTrace: trace });
const linked = new Set<string>();
const association = {
  groupId: "fixture_group",
  associationId: "fixture_association",
  selectionId: "fixture_selection"
};
let removed = false;
const onAssociation: RendererPlatform["projectAssociation"] = async (input) => {
  trace.push(input);
  if (input.operation === "create" || input.operation === "accept") {
    linked.add(input.localProjectId);
    removed = false;
  }
  if (input.operation === "forget") linked.delete(input.localProjectId);
  if (input.operation === "set") removed = input.remoteName === null;
  const remote =
    input.localProjectId === project.checkouts![1]!.localProjectId
      ? "upstream"
      : "origin";
  const result: ProjectSelectionCommandResult = {
    groupId: association.groupId,
    checkoutId: project.checkouts!.find(
      (folder) => folder.localProjectId === input.localProjectId
    )!.repository!.checkoutId!,
    defaultRemote: remote,
    deviceLabels: { fixture_device: "This device" },
    remotes: [
      {
        name: remote,
        display: repository.anchorDisplay,
        fingerprint: repository.key
      }
    ],
    accepted: linked.has(input.localProjectId) ? association : null,
    associations: [
      {
        ...association,
        state: {
          state: removed ? "deleted" : "selected",
          heads: ["fixture_revision"],
          anchorFingerprint: removed ? undefined : repository.key,
          revisions: [
            {
              revisionId: "fixture_revision",
              authorDeviceId: "fixture_device",
              replaces: [],
              operation: removed
                ? { kind: "delete" }
                : { kind: "set", anchorFingerprint: repository.key }
            }
          ]
        }
      }
    ]
  };
  return result;
};
const onSetAnchor: RendererPlatform["setRepositoryAnchor"] = async (input) => {
  trace.push(input);
};
const onReview: RendererPlatform["reviewRepository"] = async (input) => {
  trace.push(input);
  return { events: [] };
};

const store = new PersonalMemoryStore({
  listProjects: async () => [
    {
      id: project.id,
      name: project.name,
      path: project.path,
      repository: project.repository,
      eventCount: project.threads.length,
      threads: project.threads
    }
  ],
  listProjectMetadata: async () => metadata,
  loadEventPage: async () => [],
  subscribe: () => () => undefined,
  assignSessionProject: async () => ({ projectId: null }),
  updateSessionTitle: async ({ title }) => ({ title }),
  updateSessionPresentation: async () => {
    throw new Error("Not used by this fixture");
  }
});
export function ProjectFolderValidation() {
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);
  return (
    <PersonalMemoryWorkspace
      store={store}
      route={{ kind: "project", projectId: project.id }}
      onNavigate={() => undefined}
      projectAssociation={onAssociation}
      setRepositoryAnchor={onSetAnchor}
      reviewRepository={onReview}
      moveProject={async () => ({ movedCount: 0, projectId: project.id })}
      revealLocalProject={async (localProjectId) => {
        trace.push({ reveal: localProjectId });
      }}
    />
  );
}
