import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import { PersonalAskView } from "./renderer/views/personal/PersonalAskView.js";
import { createManagedConversationValidationApi } from "./managed-conversation-validation-api.js";
import { personalFolderExecutionId } from "@koed/shared/personal-desktop";
import { useEffect, useState } from "react";
import { createProjectSourceFixture } from "./project-source-fixture.js";
import { PersonalMemoryStore } from "./renderer/state/personal-memory.js";
import {
  PersonalMemoryWorkspace,
  type PersonalMemoryRoute
} from "./renderer/views/personal/PersonalMemoryViews.js";

const fixture = createProjectSourceFixture();
const askValidation = new URLSearchParams(location.search).has("ask");
const headerSwitching = new URLSearchParams(location.search).has("headers");
const secondProject = {
  ...fixture.groups.find((project) => project.id === fixture.projectId)!,
  id: "00000000-0000-4000-8000-000000000900",
  name: "Second Project",
  namedProject: {
    ...fixture.project.namedProject!,
    projectId: "00000000-0000-4000-8000-000000000900",
    name: "Second Project"
  },
  projectReference: {
    ownerUserId: fixture.ownerUserId,
    projectId: "00000000-0000-4000-8000-000000000900"
  },
  inclusionRules: [],
  directInclusions: [],
  eventCount: 0,
  threads: []
};
const trace: unknown[] = [];
Object.assign(window, {
  projectsDefaultValidationTrace: trace,
  projectsDefaultValidationIds: {
    projectId: fixture.projectId,
    secondProjectId: secondProject.id,
    notesExecutionId: personalFolderExecutionId(fixture.notes.reference)
  }
});
const { api: managed, trace: managedTrace } =
  createManagedConversationValidationApi({
    onStart: (input) => trace.push({ type: "start", input })
  });
Object.assign(window, { askValidationTrace: managedTrace });
const personalApi: PersonalDesktopApi = {
  listProjects: async () => [
    ...fixture.groups,
    ...(headerSwitching ? [secondProject] : [])
  ],
  listProjectMetadata: async () => fixture.metadata,
  listLocalFolders: async () => fixture.localFolders,
  projectStatus: async () => ({ reconciliationPending: false }),
  loadEventPage: async () => [],
  subscribe: () => () => undefined,
  updateSessionPresentation: async () => {
    throw new Error("Synthetic fixture is read-only");
  },
  updateSessionTitle: async ({ title }) => ({ title })
};
const store = new PersonalMemoryStore(personalApi);

/** Isolated UI demonstration with synthetic data and a simulated AI Client. */
export function ProjectsDefaultValidation() {
  const [route, setRoute] = useState<PersonalMemoryRoute>({
    kind: "project",
    projectId: fixture.projectId
  });
  useEffect(() => {
    document.documentElement.dataset.browserValidationReady = "true";
  }, []);
  if (askValidation)
    return (
      <PersonalAskView
        api={personalApi}
        managedConversations={managed}
        markdownAdapters={{
          openExternal: async () => undefined,
          writeClipboard: async () => undefined
        }}
        projects={fixture.inventory.projects}
        inventory={fixture.inventory}
        onNew={() => undefined}
      />
    );
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PersonalMemoryWorkspace
          managedConversations={managed}
          manageProject={
            headerSwitching
              ? async () => {
                  throw new Error("Synthetic fixture is read-only");
                }
              : undefined
          }
          manageMembershipSync={
            headerSwitching
              ? async () => {
                  throw new Error("Synthetic fixture is read-only");
                }
              : undefined
          }
          store={store}
          route={route}
          onNavigate={setRoute}
        />
      </div>
    </div>
  );
}
