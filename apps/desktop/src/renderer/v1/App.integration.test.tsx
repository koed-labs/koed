// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { KoedServerStatus } from "../../types.js";
import { DesktopStatusStore } from "../services/desktop-commands.js";
import type {
  V1ConversationIntent,
  V1Profile,
  V1Provenance
} from "../../ipc/v1-state-protocol.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationLaunchOptions
} from "../../ipc/managed-conversation-protocol.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const inventoryLoad = vi.hoisted(() => ({
  pending: null as Promise<unknown> | null,
  calls: 0
}));
const desktopStatus = vi.hoisted(() => ({
  status: {
    state: "healthy",
    api: { state: "healthy" }
  } as KoedServerStatus | null,
  error: null as string | null
}));
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const localProject = {
  id: "chats",
  name: "Chats",
  localProjectId: "lp_00000000000000000000000000000001",
  path: null,
  threads: []
} as unknown as DesktopProject;
const externalProject = {
  id: uuid(99),
  name: "External captured Project",
  namedProject: { projectId: uuid(99) },
  threads: [
    {
      id: uuid(98),
      sessionId: uuid(98),
      name: "External captured Conversation"
    }
  ]
} as unknown as DesktopProject;
const snapshot = {
  projectsById: new Map([
    [localProject.id, localProject],
    [externalProject.id, externalProject]
  ]),
  loading: false,
  projectOrder: [localProject.id, externalProject.id],
  revision: 1,
  inventory: {
    localFolders: [],
    folders: [],
    localCheckouts: [],
    projects: [],
    gitSources: [],
    unresolved: []
  }
};
vi.mock("../state/personal-memory.js", () => ({
  PersonalMemoryStore: class {
    current = () => snapshot;
    subscribe = () => () => undefined;
    loadProjects = async () => {
      inventoryLoad.calls++;
      return inventoryLoad.pending ?? snapshot;
    };
    upsertThread = () => undefined;
  }
}));
vi.mock("../services/platform.js", () => ({
  createRendererPlatform: () => ({
    ensureIndependentProject: async () => ({
      localProjectId: "lp_00000000000000000000000000000001"
    })
  })
}));
vi.mock("../../collaboration/renderer-client.js", () => ({
  createCollaborationRendererClient: () => ({
    subscribe: () => () => undefined,
    load: async () => ({}),
    dispose: () => undefined
  })
}));
vi.mock("../state/use-status.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state/use-status.js")>();
  const fixtureStore = {
    current: () => desktopStatus,
    subscribe: () => () => undefined
  } as unknown as DesktopStatusStore;
  return {
    useDesktopStatus: (store: DesktopStatusStore) =>
      actual.useDesktopStatus(
        typeof store.current === "function" ? store : fixtureStore
      )
  };
});
vi.mock("../views/personal/PersonalMemoryViews.js", () => ({
  StoreConversation: () => <div>Conversation opened</div>
}));
vi.mock("../views/personal/use-slash-command-discovery.js", () => ({
  useSlashCommandDiscovery: () => ({
    commands: [],
    loading: false,
    error: null
  })
}));
import { V1App } from "./App.js";

const options: ManagedConversationLaunchOptions = {
  runners: [
    {
      kind: "local_device",
      deploymentId: uuid(1),
      deviceId: uuid(2),
      displayName: "This device"
    }
  ],
  instances: [
    {
      instanceId: "client-1",
      driverId: "codex",
      displayName: "Codex",
      ready: true,
      readiness: "ready",
      models: [
        {
          id: "model-1",
          displayName: "Model 1",
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
          isDefault: true
        }
      ],
      capabilities: {
        defaultPermissionMode: "supervised",
        permissionModes: [{ mode: "supervised", support: "supported" }]
      }
    }
  ]
};

describe("V1App launch integration", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    inventoryLoad.pending = null;
    inventoryLoad.calls = 0;
    desktopStatus.status = {
      state: "healthy",
      api: { state: "healthy" }
    } as KoedServerStatus;
    desktopStatus.error = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("follows cold-start lifecycle events and service readiness without showing an empty inventory", async () => {
    vi.useFakeTimers();
    let status = {
      state: "needs_attention",
      api: { state: "needs_attention" },
      lifecycle: { state: "stopped", message: "Stopped" }
    } as KoedServerStatus;
    const listeners = new Set<() => void>();
    const invoke = vi.fn(async () => structuredClone(status));
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        invoke,
        status: {
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }
        },
        v1State: {
          readProfile: async () => ({
            agentName: "Ada",
            onboarding: { selections: {}, completed: true }
          }),
          readIdentity: async () => ({
            ownerId: uuid(3),
            scopeKey: "a".repeat(64)
          }),
          readProvenance: async () => ({
            schemaVersion: 1,
            projects: {},
            conversations: {}
          })
        }
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const statusStore = new DesktopStatusStore();
    await act(async () =>
      root!.render(
        <V1App
          personalMemoryApi={{} as never}
          managedConversations={null}
          statusStore={statusStore}
          themeStore={{ load: async () => undefined } as never}
        />
      )
    );
    expect(container.textContent).toContain("Services are stopped");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
    expect(inventoryLoad.calls).toBe(0);

    // The window opens before runtime startup. Its first lifecycle event must
    // refresh the status store even though the API is not ready yet.
    status = {
      ...status,
      lifecycle: { state: "starting", message: "Starting" }
    };
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(container.textContent).toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
    expect(inventoryLoad.calls).toBe(0);

    // A running supervisor is not yet a ready API. Readiness may change
    // without another lifecycle epoch, so the regular probe must pick it up.
    status = { ...status, lifecycle: { state: "running", message: "Running" } };
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(container.textContent).toContain("Services starting…");
    status = {
      ...status,
      state: "healthy",
      api: { ...status.api, state: "healthy" }
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).toContain("External captured Conversation");
    expect(inventoryLoad.calls).toBeGreaterThan(0);
    const readyProbes = invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(invoke).toHaveBeenCalledTimes(readyProbes);

    status = {
      ...status,
      api: { ...status.api, state: "needs_attention" },
      lifecycle: { state: "unavailable", message: "Unavailable" }
    };
    await act(async () => {
      for (const listener of listeners) listener();
    });
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).toContain("Services are unavailable");
    expect(container.textContent).toContain("External captured Conversation");
    await act(async () => root!.unmount());
    root = undefined;
    expect(listeners.size).toBe(0);
  });
  it("hides the previous owner's inventory while the new owner's inventory loads", async () => {
    let scopeKey = "a".repeat(64);
    let statusChanged: (() => void) | undefined;
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        status: {
          subscribe: (listener: () => void) => {
            statusChanged = listener;
            return () => {};
          }
        },
        v1State: {
          readProfile: async () => ({
            agentName: "Ada",
            onboarding: { selections: {}, completed: true }
          }),
          readIdentity: async () => ({ ownerId: uuid(3), scopeKey }),
          readProvenance: async () => ({
            schemaVersion: 1,
            projects: {},
            conversations: {}
          })
        }
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <V1App
          personalMemoryApi={{} as never}
          managedConversations={null}
          statusStore={{ refresh: async () => undefined } as never}
          themeStore={{ load: async () => undefined } as never}
        />
      )
    );
    expect(container.textContent).toContain("External captured Conversation");
    let finish!: (value: unknown) => void;
    inventoryLoad.pending = new Promise((resolve) => {
      finish = resolve;
    });
    scopeKey = "b".repeat(64);
    await act(async () => statusChanged!());
    expect(container.textContent).not.toContain(
      "External captured Conversation"
    );
    await act(async () =>
      finish({ ...snapshot, error: "New owner's inventory is unavailable" })
    );
    expect(container.textContent).not.toContain(
      "External captured Conversation"
    );
  });
  it("expands Projects without replacing the conversation pane and selects an existing Project for launching", async () => {
    const namedId = uuid(30),
      requestId = uuid(31);
    const identity = {
      originatingDeploymentId: uuid(1),
      originatingDeviceId: uuid(2),
      originatingProfileId: uuid(3),
      folderId: uuid(4),
      directoryIncarnationId: uuid(5)
    };
    const reference = { ...identity, ownerUserId: uuid(3) };
    const named = {
      id: namedId,
      name: "Made here",
      ownerUserId: uuid(3),
      namedProject: { projectId: namedId, version: 1 },
      inclusionRules: [
        { target: { kind: "folder", folder: reference }, removedAt: null }
      ],
      threads: []
    } as unknown as DesktopProject;
    snapshot.projectsById.set(namedId, named);
    (snapshot.inventory.localFolders as unknown[]).push({
      identity,
      normalizedPath: "/tmp/koed-v1-project",
      capturedPath: "/tmp/koed-v1-project"
    });
    const registry: V1Provenance = {
      schemaVersion: 1,
      conversations: {},
      projects: {
        [requestId]: {
          requestId,
          name: "Made here",
          projectId: namedId,
          createdAt: new Date().toISOString()
        }
      }
    };
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        v1State: {
          readProfile: async () => ({
            agentName: "Ada",
            onboarding: { selections: {}, completed: true }
          }),
          readIdentity: async () => ({
            ownerId: uuid(3),
            scopeKey: "a".repeat(64)
          }),
          readProvenance: async () => registry
        },
        collaboration: {
          command: async () => ({}),
          subscribe: () => () => undefined
        }
      }
    });
    const managed = {
      launchOptions: async () => ({ operation: "launch_options", options }),
      readRecovery: async () => ({ operation: "recovery_read", value: "" })
    } as unknown as ManagedConversationDesktopApi;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <V1App
          personalMemoryApi={{} as never}
          managedConversations={managed}
          onboardingComplete
          statusStore={{ refresh: async () => undefined } as never}
          themeStore={{ load: async () => undefined } as never}
        />
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const rail = [
      ...container.querySelectorAll<HTMLButtonElement>(".v1-nav-project")
    ].find((button) => button.textContent?.includes("Made here"));
    expect(rail).toBeDefined();
    await act(async () => rail!.click());
    expect(container.querySelector(".v1-project-page")).toBeNull();
    expect(
      container.querySelector('[aria-label="First message"]')
    ).not.toBeNull();
    await act(async () =>
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Select Project"]')!
        .click()
    );
    const choice = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ].find((button) => button.textContent === "Made here");
    await act(async () => choice!.click());
    expect(
      container.querySelector('[aria-label="Select Project"]')?.textContent
    ).toContain("Made here");
    expect(container.textContent).toContain("koed-v1-project");
    snapshot.projectsById.delete(namedId);
    (snapshot.inventory.localFolders as unknown[]).length = 0;
  });

  it("shows external captures and persists intent and first prompt before backend calls", async () => {
    const calls: string[] = [];
    const state: { profile: V1Profile; provenance: V1Provenance } = {
      profile: {
        agentName: "Ada",
        onboarding: { selections: {}, completed: true }
      },
      provenance: { schemaVersion: 1, conversations: {}, projects: {} }
    };
    const v1State = {
      readProfile: async () => state.profile,
      writeProfile: async (value: V1Profile) => (state.profile = value),
      readIdentity: async () => ({
        ownerId: uuid(3),
        scopeKey: "a".repeat(64)
      }),
      readProvenance: async () => state.provenance,
      putConversationIntent: async (intent: V1ConversationIntent) => {
        calls.push("intent");
        state.provenance = {
          ...state.provenance,
          conversations: {
            ...state.provenance.conversations,
            [intent.idempotencyKey]: intent
          }
        };
        return intent;
      },
      ackConversation: async ({
        idempotencyKey,
        executionId
      }: {
        idempotencyKey: string;
        executionId: string;
      }) => {
        calls.push("ack");
        const intent = {
          ...state.provenance.conversations[idempotencyKey]!,
          executionId
        };
        state.provenance = {
          ...state.provenance,
          conversations: {
            ...state.provenance.conversations,
            [idempotencyKey]: intent
          }
        };
        return intent;
      },
      saveInitialPrompt: async ({
        idempotencyKey,
        initialPrompt
      }: {
        idempotencyKey: string;
        initialPrompt: V1ConversationIntent["initialPrompt"];
      }) => {
        calls.push("prompt-persist");
        const intent = {
          ...state.provenance.conversations[idempotencyKey]!,
          initialPrompt
        };
        state.provenance = {
          ...state.provenance,
          conversations: {
            ...state.provenance.conversations,
            [idempotencyKey]: intent
          }
        };
        return intent;
      }
    };
    const managed = {
      launchOptions: async () => ({ operation: "launch_options", options }),
      start: async () => {
        calls.push("start");
        return {
          operation: "start",
          status: "ready",
          executionId: uuid(4),
          conversation: {
            executionId: uuid(4),
            projectId: localProject.localProjectId!,
            capturedSessionId: uuid(4),
            threadId: uuid(4)
          }
        };
      },
      send: async () => {
        calls.push("send");
        return {
          operation: "send",
          status: "queued",
          message: "",
          conversation: {
            executionId: uuid(4),
            projectId: localProject.localProjectId!,
            capturedSessionId: uuid(4),
            threadId: uuid(4)
          }
        };
      },
      writeDraft: async () => ({ operation: "draft_write", ok: true }),
      deleteDraft: async () => ({ operation: "draft_delete", ok: true }),
      readRecovery: async () => ({ operation: "recovery_read", value: "" }),
      writeRecovery: async () => ({ operation: "recovery_write", ok: true }),
      inspect: async () => ({
        operation: "inspect",
        status: "ready",
        executionId: uuid(4),
        conversation: {
          executionId: uuid(4),
          projectId: localProject.localProjectId!,
          capturedSessionId: uuid(4),
          threadId: uuid(4)
        }
      })
    } as unknown as ManagedConversationDesktopApi;
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: {
        v1State,
        localAiClients: { list: async () => null },
        collaboration: {
          command: async () => ({}),
          subscribe: () => () => undefined
        },
        setup: { inspect: async () => ({}) }
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <V1App
          personalMemoryApi={{} as never}
          managedConversations={managed}
          onboardingComplete
          statusStore={{ refresh: async () => undefined } as never}
          themeStore={{ load: async () => undefined } as never}
        />
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(container.textContent).toContain("External captured Conversation");
    const captured = container.querySelector<HTMLButtonElement>(
      ".v1-nav-conversation"
    );
    await act(async () => captured!.click());
    expect(container.textContent).toContain("Conversation opened");
    expect(container.querySelector('[aria-label="Create Project"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Projects for"]')).toBeNull();
    await act(async () =>
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Koed, home"]')!
        .click()
    );
    const projectButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Project"]'
    );
    await act(async () => projectButton?.click());
    expect(container.textContent).toContain("External captured Project");
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="First message"]'
    );
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "Hello");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="Send"]')
        ?.click()
    );
    expect(calls.slice(0, 2)).toEqual(["intent", "start"]);
    expect(calls.indexOf("ack")).toBeLessThan(calls.indexOf("send"));
    expect(calls.indexOf("prompt-persist")).toBeLessThan(calls.indexOf("send"));
    expect(
      Object.values(state.provenance.conversations)[0]?.initialPrompt
        ?.clientUserMessageId
    ).toBeTruthy();
  });
});
