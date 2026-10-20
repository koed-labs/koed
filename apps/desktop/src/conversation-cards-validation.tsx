import { Pin } from "lucide-react";
import { useMemo } from "react";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import type { PersonalGitContext } from "@koed/shared";
import { PersonalMemoryStore } from "./renderer/state/personal-memory.js";
import { ConversationProjectsDialog } from "./renderer/views/personal/ConversationProjectsDialog.js";
import { SourceContextCorrectionDialog } from "./renderer/views/personal/SourceContextCorrectionDialog.js";
import type { SourceContext } from "./renderer/views/personal/SourceContextCompare.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-20T12:00:00.000Z";
const git: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_koed",
  root: "/work/koed",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/koed"
};
const folder = {
  reference: {
    ownerUserId: uuid(99),
    folderId: "api",
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: "incarnation"
  },
  normalizedPath: "/work/koed/api",
  capturedPath: "/work/koed/api"
};
const design = {
  ...folder,
  reference: {
    ...folder.reference,
    folderId: "design",
    directoryIncarnationId: "design-incarnation"
  },
  normalizedPath: "/work/koed/design",
  capturedPath: "/work/koed/design"
};
const thread: PersonalDesktopProjectThread = {
  id: "source",
  name: "Memory Answer workflow",
  sessionId: uuid(100),
  projectId: "git",
  projectName: "koed",
  projectPath: git.root,
  capturedCwd: folder.capturedPath,
  sourceAiClient: "codex",
  projectAssignmentSource: "detected",
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: stamp,
  sample: "",
  presentation: null
};
const catalog: PersonalDesktopProject[] = [
  {
    id: "git",
    name: "koed",
    path: git.root,
    repository: git,
    threads: [thread],
    eventCount: 1
  },
  ...[folder, design].map((item, index) => ({
    id: `folder-${index}`,
    name: index ? "Design" : "API",
    path: item.normalizedPath,
    folder: item,
    threads: [thread],
    eventCount: 1
  })),
  ...Array.from({ length: 16 }, (_, index) => ({
    id: uuid(index + 1),
    name:
      index === 0
        ? "Product research"
        : index === 1
          ? "Release planning"
          : `Project ${index + 1}`,
    path: null,
    eventCount: 0,
    threads: [],
    namedProject: {
      projectId: uuid(index + 1),
      name:
        index === 0
          ? "Product research"
          : index === 1
            ? "Release planning"
            : `Project ${index + 1}`,
      version: 1,
      headRevisionId: uuid(index + 30),
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp
    }
  }))
];
const manage: NonNullable<PersonalDesktopApi["manageProject"]> = async (
  input
) => {
  const project = catalog.find((row) => row.id === input.projectId)!;
  if (input.action !== "explain_session")
    throw new Error(
      "Layout fixture: membership writes are covered by focused tests."
    );
  const index = catalog
    .filter((row) => row.namedProject)
    .findIndex((row) => row.id === input.projectId);
  return {
    project: project.namedProject!,
    explanation: {
      sessionId: thread.sessionId!,
      logicalSessionId: uuid(101),
      included: index < 2,
      exclusion: null,
      reasons:
        index === 0
          ? [
              {
                kind: "repository",
                inclusionId: uuid(200),
                revisionId: uuid(201)
              },
              { kind: "folder", inclusionId: uuid(202), revisionId: uuid(203) }
            ]
          : index === 1
            ? [
                {
                  kind: "session",
                  inclusionId: uuid(204),
                  revisionId: uuid(205)
                }
              ]
            : []
    }
  };
};
let context: SourceContext = {
  sessionId: thread.sessionId!,
  logicalSessionId: uuid(101),
  git: {
    revision: 1,
    original: { state: "known", value: git },
    correction: { state: "original" }
  },
  folder: {
    revision: 1,
    original: { state: "known", value: folder },
    correction: { state: "original" }
  }
};
let reviewed: SourceContext | null = null;
const manageSource: NonNullable<
  PersonalDesktopApi["manageSourceContext"]
> = async (input) => {
  if (input.action === "get") return { context };
  if (input.action === "apply") {
    if (!reviewed) throw new Error("Preview required");
    context = reviewed;
    document.documentElement.dataset.sourceCorrectionApplied = "true";
    return { context };
  }
  const correction = input.correction;
  const axis = correction.axis;
  reviewed = { ...context };
  if (correction.action === "reset") {
    reviewed = {
      ...context,
      [axis]: {
        ...context[axis],
        revision: context[axis].revision + 1,
        correction: { state: "original" }
      }
    };
  } else if (correction.action === "unresolved") {
    reviewed = {
      ...context,
      [axis]: {
        ...context[axis],
        revision: context[axis].revision + 1,
        correction: {
          state: "corrected",
          revisionId: uuid(300),
          value: { state: "unresolved", reason: "explicit_unresolved" }
        }
      }
    };
  } else if (correction.action === "set" && correction.axis === "git") {
    reviewed.git = {
      ...context.git,
      revision: context.git.revision + 1,
      correction: {
        state: "corrected",
        revisionId: uuid(300),
        value: { state: "known", value: correction.repository }
      }
    };
  } else if (correction.action === "set" && correction.axis === "folder") {
    reviewed.folder = {
      ...context.folder,
      revision: context.folder.revision + 1,
      correction: {
        state: "corrected",
        revisionId: uuid(301),
        value: {
          state: "known",
          value:
            correction.folder.folderId === design.reference.folderId
              ? design
              : folder
        }
      }
    };
  }
  return {
    context,
    preview: {
      reviewId: uuid(302),
      axis,
      expectedVersion: context[axis].revision,
      before: context,
      after: reviewed,
      projects: [
        {
          projectId: uuid(1),
          name: "Product research",
          version: 1,
          beforeIncluded: true,
          afterIncluded: true,
          beforeReasons: [
            {
              kind: "repository",
              inclusionId: uuid(200),
              revisionId: uuid(201)
            }
          ],
          afterReasons: [
            {
              kind: "repository",
              inclusionId: uuid(200),
              revisionId: uuid(201)
            }
          ]
        }
      ]
    }
  };
};
export function ConversationCardsValidation() {
  const store = useMemo(
    () =>
      new PersonalMemoryStore({
        listProjects: async () => catalog,
        loadEventPage: async () => [],
        subscribe: () => () => undefined
      } as unknown as PersonalDesktopApi),
    []
  );
  return (
    <main style={{ padding: "2rem" }}>
      <h2>{thread.name}</h2>
      <details
        open
        className="personal-session-actions"
        style={{
          position: "relative",
          top: 0,
          right: 0,
          transform: "none",
          marginTop: "1rem",
          width: "16rem"
        }}
      >
        <summary aria-label="Conversation actions">Actions</summary>
        <div role="menu" aria-label="Conversation actions">
          <button type="button" role="menuitem">
            <Pin aria-hidden="true" />
            Pin
          </button>
          <ConversationProjectsDialog
            thread={thread}
            projects={catalog}
            manage={manage}
            store={store}
            menuitem
            create={async () => null}
          />
          <SourceContextCorrectionDialog
            thread={thread}
            projects={catalog}
            manage={manageSource}
            store={store}
            menuitem
          />
        </div>
      </details>
    </main>
  );
}
