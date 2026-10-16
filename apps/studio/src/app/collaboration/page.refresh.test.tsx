// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { StudioCollaborationRequestError } from "@/lib/studio-collaboration-client";

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn(),
  workspaceMountCount: 0
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/lib/studio-collaboration-client", () => ({
  StudioCollaborationClient: class {
    loadSession() {
      return mocks.loadSession();
    }
  },
  StudioCollaborationRequestError: class extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
}));

vi.mock("@/components/desktop-collaboration/TeamChannelWorkspace", async () => {
  const React = await import("react");
  return {
    TeamChannelWorkspace: ({ onRefresh }: { onRefresh: () => void }) => {
      const [mountId] = React.useState(() => ++mocks.workspaceMountCount);
      return React.createElement(
        "section",
        { "data-testid": "team-workspace", "data-mount-id": mountId },
        React.createElement(
          React.Fragment,
          null,
          React.createElement("textarea", {
            "aria-label": "Project name",
            defaultValue: ""
          }),
          React.createElement(
            "button",
            { type: "button", onClick: onRefresh },
            "Refresh Team connection"
          )
        )
      );
    }
  };
});

vi.mock(
  "@/components/desktop-collaboration/DesktopCollaborationStudio",
  async () => {
    const React = await import("react");
    return {
      DesktopCollaborationRecoveryRail: () =>
        React.createElement("aside", { "data-testid": "recovery-rail" })
    };
  }
);

vi.mock("@/components/WorkspaceProvider", async () => {
  const React = await import("react");
  return {
    WorkspaceProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useWorkspace: () => ({
      activeTeamId: "",
      hydrated: false,
      setActiveTeamId: () => undefined,
      workspace: { teams: [] }
    })
  };
});

vi.mock("@/components/CollabSessionContext", async () => {
  const React = await import("react");
  return {
    CollabSessionProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children)
  };
});

vi.mock("@/components/SidebarContext", async () => {
  const React = await import("react");
  return {
    SidebarProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children)
  };
});

vi.mock("@/components/CollabWorkspace", () => ({
  CollabWorkspace: () => null
}));
vi.mock("@/components/ContextSidebar", () => ({ ContextSidebar: () => null }));
vi.mock("@/components/GlobalNav", () => ({ GlobalNav: () => null }));
vi.mock("@/components/hosted/HostedStudio", () => ({
  HostedStudio: () => null
}));

import CollaborationPage from "./page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

function snapshot({
  backendId = "backend-a",
  principalId = "principal-a",
  teamIds = ["team-a"]
}: {
  backendId?: string;
  principalId?: string;
  teamIds?: string[];
} = {}) {
  return {
    connection: { backendId },
    navigation: {
      teamPrincipal: { id: principalId },
      teams: teamIds.map((id) => ({
        id,
        role: "owner",
        lifecycle: "active",
        membershipVersion: 1,
        sharedProjects: [],
        workspaces: []
      }))
    }
  } as unknown as CollaborationSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function mount(initialSnapshot: CollaborationSnapshot) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.loadSession.mockResolvedValueOnce(initialSnapshot);
  await act(async () => {
    root.render(<CollaborationPage />);
    await Promise.resolve();
  });
}

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  mocks.workspaceMountCount = 0;
  mocks.loadSession.mockReset();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible"
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllEnvs();
});

it("keeps the project form mounted during and after same-scope focus refresh", async () => {
  const current = snapshot();
  const nextSession = deferred<CollaborationSnapshot>();
  await mount(current);
  mocks.loadSession.mockReturnValueOnce(nextSession.promise);

  const workspace = container.querySelector('[data-testid="team-workspace"]');
  const projectName = container.querySelector("textarea")!;
  projectName.value = "Ticket 13 Docker Project";

  await focusWindow();
  expect(container.querySelector('[data-testid="team-workspace"]')).toBe(
    workspace
  );
  expect(projectName.value).toBe("Ticket 13 Docker Project");

  await act(async () => nextSession.resolve(current));
  expect(container.querySelector('[data-testid="team-workspace"]')).toBe(
    workspace
  );
  expect(container.querySelector("textarea")).toBe(projectName);
  expect(projectName.value).toBe("Ticket 13 Docker Project");
});

it("fails closed and clears the workspace when focus revalidation fails", async () => {
  await mount(snapshot());
  mocks.loadSession.mockRejectedValueOnce(new Error("connection lost"));

  await focusWindow();

  expect(container.querySelector('[data-testid="team-workspace"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="recovery-rail"]')
  ).not.toBeNull();
  expect(container.textContent).toContain("Team connection unavailable");
});

it("does not fall back to preview when a loaded Team session returns 404", async () => {
  await mount(snapshot());
  mocks.loadSession.mockRejectedValueOnce(
    new StudioCollaborationRequestError("session not found", 404)
  );

  await focusWindow();

  expect(container.querySelector('[data-testid="team-workspace"]')).toBeNull();
  expect(
    container.querySelector('[data-testid="recovery-rail"]')
  ).not.toBeNull();
  expect(container.textContent).toContain("Team connection unavailable");
});

it("does not treat the refresh button event as the preserve-workspace option", async () => {
  const current = snapshot();
  const nextSession = deferred<CollaborationSnapshot>();
  await mount(current);
  mocks.loadSession.mockReturnValueOnce(nextSession.promise);
  const oldWorkspace = container.querySelector(
    '[data-testid="team-workspace"]'
  );

  await act(async () => {
    container.querySelector("button")!.click();
    await Promise.resolve();
  });

  expect(container.querySelector('[data-testid="team-workspace"]')).toBeNull();
  await act(async () => nextSession.resolve(current));
  expect(container.querySelector('[data-testid="team-workspace"]')).not.toBe(
    oldWorkspace
  );
});

it("does not let an older successful refresh override the latest failure", async () => {
  await mount(snapshot());
  const staleSession = deferred<CollaborationSnapshot>();
  mocks.loadSession
    .mockReturnValueOnce(staleSession.promise)
    .mockRejectedValueOnce(new Error("latest connection failed"));

  await focusWindow();
  await focusWindow();

  expect(container.querySelector('[data-testid="team-workspace"]')).toBeNull();
  expect(container.textContent).toContain("Team connection unavailable");

  await act(async () => staleSession.resolve(snapshot()));
  expect(container.querySelector('[data-testid="team-workspace"]')).toBeNull();
  expect(container.textContent).toContain("Team connection unavailable");
});

it.each([
  ["backend", { backendId: "backend-b" }],
  ["principal", { principalId: "principal-b" }],
  ["Team access", { teamIds: ["team-b"] }]
])(
  "resets workspace state when the %s scope changes",
  async (_label, change) => {
    await mount(snapshot());
    const oldWorkspace = container.querySelector(
      '[data-testid="team-workspace"]'
    );
    const projectName = container.querySelector("textarea")!;
    projectName.value = "Private draft";
    mocks.loadSession.mockResolvedValueOnce(snapshot(change));

    await focusWindow();

    const newWorkspace = container.querySelector(
      '[data-testid="team-workspace"]'
    );
    expect(newWorkspace).not.toBe(oldWorkspace);
    expect(container.querySelector("textarea")).not.toBe(projectName);
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value
    ).toBe("");
  }
);
