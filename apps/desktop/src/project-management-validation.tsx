/** Mount the production V1App and StoreConversation against an isolated bridge. */
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationSnapshotSchema,
  type CollaborationRendererCommand
} from "@koed/shared/collaboration";
import { V1App } from "./renderer/v1/App.js";
import { installOnboardingValidation } from "./onboarding-validation.js";
import {
  createProjectManagementValidationApi,
  validationId,
  validationOwner
} from "./project-management-validation-api.js";
import type { V1Profile } from "./ipc/v1-state-protocol.js";
import { useState } from "react";
import type { KoedServerStatus } from "./types.js";

export function installProjectManagementValidation() {
  const onboarding = installOnboardingValidation();
  if (new URLSearchParams(window.location.search).get("services") === "stopped")
    onboarding.fixture.setUnavailable();
  const bridge = window.koedDesktop!;
  const fixture = createProjectManagementValidationApi();
  const stamp = new Date().toISOString();
  const independent = {
    schemaVersion: 1,
    localProjectId: "validation-chats",
    displayName: "Chats",
    contextKind: "independent",
    discoveredAt: stamp,
    lastSeenAt: stamp,
    path: { cwd: "/validation/chats", projectRoot: null }
  } as const;
  fixture.api.listProjectMetadata = async () => [independent];
  let profile: V1Profile = {
    agentName: "Koed",
    onboarding: { completed: true, selections: {} }
  };
  const originalInvoke = bridge.invoke;
  // Exercise a running supervisor whose API becomes ready on a later probe.
  let startupStatusReads = new URLSearchParams(window.location.search).has(
    "startup"
  )
    ? 2
    : 0;
  const snapshot = collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "project_management_validation_1",
    generatedAt: stamp,
    connection: {
      state: "live",
      backendId: null,
      connectedAt: stamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: {
        id: validationOwner,
        displayName: "Hill",
        presence: "available",
        membershipState: "enabled"
      },
      teamPrincipal: null,
      personal: { memory: [], channels: [] },
      teams: []
    },
    selection: { kind: "personal_memory" },
    view: { kind: "empty" }
  });
  Object.assign(bridge, {
    personalMemory: fixture.api,
    v1State: {
      readProfile: async () => structuredClone(profile),
      writeProfile: async (next: V1Profile) => {
        profile = next;
        return structuredClone(profile);
      },
      readIdentity: async () => ({
        ownerId: validationOwner,
        scopeKey: "project-management-validation"
      }),
      readProvenance: async () => ({
        schemaVersion: 1,
        projects: {},
        conversations: {}
      })
    },
    collaboration: {
      subscribe: () => () => {},
      command: async (command: CollaborationRendererCommand) => ({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: command.requestId,
        command: command.command,
        ok: true,
        data:
          command.command === "collaboration.load"
            ? { snapshot }
            : command.command === "collaboration.subscribe"
              ? {
                  subscription: {
                    id: validationId(998),
                    scope: { scope: "personal" },
                    state: "active",
                    version: 1,
                    expiresAt: "2099-01-01T00:00:00.000Z"
                  }
                }
              : {}
      })
    },
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "ensure_independent_project")
        return { project: independent };
      if (command === "status" && startupStatusReads > 0) {
        startupStatusReads--;
        const status = await originalInvoke<KoedServerStatus>("status");
        return {
          ...status,
          state: "needs_attention",
          api: { ...status.api, state: "needs_attention" }
        };
      }
      return originalInvoke(command as never, args);
    },
    theme: {
      get: async () =>
        new URLSearchParams(location.search).get("theme") === "light"
          ? "light"
          : "dark",
      set: async (value: string) => ({
        preference: value,
        resolvedDark: value === "dark"
      })
    }
  });
  return fixture;
}

export function ProjectManagementValidation() {
  const [dark, setDark] = useState(true);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: 28,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          fontSize: 11,
          background: "var(--background)",
          borderBottom: "1px solid var(--border)"
        }}
      >
        <span>Production Project management · sample data</span>
        <button
          onClick={() => {
            document.documentElement.classList.toggle("light", dark);
            document.documentElement.classList.toggle("dark", !dark);
            setDark(!dark);
          }}
        >
          Toggle theme
        </button>
      </div>
      <V1App onboardingComplete managedConversations={null} />
    </div>
  );
}
