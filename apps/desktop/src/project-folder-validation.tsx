import { useEffect } from "react";
import type { ProjectSelectionCommandResult } from "@koed/shared/project-selection";
import { mergeProjectSources } from "./project-memory-ui.js";
import type { RendererPlatform } from "./renderer/services/platform.js";
import { ProjectHeader } from "./renderer/views/personal/ProjectHeader.js";

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
const project = mergeProjectSources(
  [],
  ["koed", "koed-alt"].map((name, index) => ({
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
  }))
)[0]!;
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

export function ProjectFolderValidation() {
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);
  return (
    <main
      style={{
        padding: "1rem",
        width: "100%",
        minHeight: "100vh",
        boxSizing: "border-box"
      }}
    >
      <section className="personal-project-detail">
        <ProjectHeader
          project={project}
          onAssociation={onAssociation}
          onSetAnchor={onSetAnchor}
          onReview={onReview}
          onRevealLocalProject={(localProjectId) =>
            trace.push({ reveal: localProjectId })
          }
        >
          <div className="personal-project-detail-actions">
            <button
              className="personal-session-manage-button"
              aria-label="Move Project"
            >
              Move
            </button>
            <button className="personal-new-conversation personal-new-conversation-standalone">
              New
            </button>
          </div>
        </ProjectHeader>
      </section>
    </main>
  );
}
