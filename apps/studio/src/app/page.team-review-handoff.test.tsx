// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Home from "./page";
import type { HomeExecution } from "@/lib/studio-contract";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  router: { replace: vi.fn(), push: vi.fn() },
  getAgent: vi.fn(),
  chatMounts: 0,
  chatUnmounts: 0,
  managedRuntimeResponse: null as unknown,
  managedRuntimeStatus: 200,
  managedRuntimeGate: null as Promise<Response> | null,
  onConversationStarted: null as ((conversation: HomeExecution) => void) | null,
  personalConversations: [] as Array<Record<string, unknown>>,
  personalConversationForExecution: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams
}));
vi.mock("@/lib/personal-agents-client", () => ({
  personalAgentsHttpAdapter: { get: mocks.getAgent }
}));
vi.mock("@/components/studio/LiveAgentChat", async () => {
  const React = await import("react");
  return {
    LiveAgentChat: (props: {
      onConversationStarted?: (conversation: HomeExecution) => void;
    }) => {
      mocks.onConversationStarted = props.onConversationStarted ?? null;
      React.useEffect(() => {
        mocks.chatMounts += 1;
        return () => {
          mocks.chatUnmounts += 1;
        };
      }, []);
      return React.createElement("div", { "data-testid": "live-chat" });
    }
  };
});
vi.mock("@/lib/use-home-feed", () => ({
  useHomeFeed: () => ({ snapshot: null })
}));
vi.mock("@/components/studio/useVerifiedPersonalScope", () => ({
  useVerifiedPersonalScope: () => null
}));
vi.mock("@/lib/personal-conversations-client", () => ({
  listPersonalConversations: async () => mocks.personalConversations
}));
vi.mock("@/lib/home-json", () => ({
  readHomeJson: (response: Response) => response.json()
}));
vi.mock("@/lib/local-projects", () => ({
  chooseLocalProjectFolder: vi.fn(),
  registerLocalProject: vi.fn(),
  useLocalProjectCapabilities: () => ({
    canCreateLocalProject: false,
    loading: false
  })
}));
vi.mock("@/lib/studio-home", () => ({ homeProjects: () => [] }));
vi.mock("@/components/studio/LocalConversationBrowser.match", () => ({
  managedProviderSourceIdsByExecution: () => ({})
}));
vi.mock("@/lib/personal-conversation-routing", () => ({
  personalConversationForExecution: mocks.personalConversationForExecution
}));
vi.mock("@/components/studio/PersonalHome", async () => {
  const React = await import("react");
  return {
    PersonalHome: (props: { onResumeChat: (id: string) => void }) =>
      React.createElement(
        "button",
        {
          "data-testid": "resume-execution",
          onClick: () =>
            props.onResumeChat("12345678-1234-4234-8234-123456789012")
        },
        "Resume"
      )
  };
});
vi.mock("@/components/studio/DemoHome", () => ({ DemoHome: () => null }));
vi.mock("@/components/studio/StudioSidebar", async () => {
  const React = await import("react");
  return {
    StudioSidebar: (props: { onHome?: () => void }) =>
      React.createElement(
        "button",
        { "data-testid": "go-home", onClick: props.onHome },
        "Home"
      )
  };
});
vi.mock("@/components/CreateProjectModal", () => ({
  CreateProjectModal: () => null
}));
vi.mock("@/components/hosted/HostedStudio", () => ({
  HostedStudio: () => null
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  mocks.searchParams = new URLSearchParams(
    "chat=1&agent=owner-agent&project=lp_example&teamRequest=request-1&teamRequestTeam=team-1&teamRequestVersion=1&teamReviewVersion=1&provider=codex&model=gpt-6-luna&effort=high&access=full&client=codex.default"
  );
  mocks.router.replace.mockReset();
  mocks.router.push.mockReset();
  mocks.getAgent.mockReset().mockResolvedValue({
    id: "owner-agent",
    lifecycle: "active",
    currentVersion: 2
  });
  mocks.chatMounts = 0;
  mocks.chatUnmounts = 0;
  mocks.managedRuntimeResponse = null;
  mocks.managedRuntimeStatus = 200;
  mocks.managedRuntimeGate = null;
  mocks.onConversationStarted = null;
  mocks.personalConversations = [];
  mocks.personalConversationForExecution.mockReset().mockReturnValue(undefined);
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/studio-api/managed-conversations/"))
        return (
          mocks.managedRuntimeGate ??
          Response.json(
            mocks.managedRuntimeResponse ?? { teamAgentRequestBinding: null },
            { status: mocks.managedRuntimeStatus }
          )
        );
      if (String(input).includes("/studio-api/projects"))
        return Response.json({ projects: [] });
      return Response.json({
        state: "ready",
        scopeKey: "test-owner",
        executions: [],
        recents: []
      });
    })
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("keeps the selected Agent chat mounted when only the Team review version advances", async () => {
  await act(async () => root.render(<Home />));
  await flushEffects();

  expect(mocks.getAgent).toHaveBeenCalledOnce();
  expect(mocks.chatMounts).toBe(1);
  expect(container.querySelector('[data-testid="live-chat"]')).not.toBeNull();

  mocks.searchParams = new URLSearchParams(
    "chat=1&agent=owner-agent&project=lp_example&teamRequest=request-1&teamRequestTeam=team-1&teamRequestVersion=1&teamReviewVersion=2&provider=codex&model=gpt-6-luna&effort=high&access=full&client=codex.default"
  );
  await act(async () => root.render(<Home />));
  await flushEffects();

  expect(mocks.getAgent).toHaveBeenCalledOnce();
  expect(mocks.chatMounts).toBe(1);
  expect(mocks.chatUnmounts).toBe(0);
  expect(container.querySelector('[data-testid="live-chat"]')).not.toBeNull();
});

it("keeps a newly accepted Team chat mounted across its execution URL update", async () => {
  const executionId = "52345678-1234-4234-8234-123456789012";
  await act(async () => root.render(<Home />));
  await flushEffects();

  expect(mocks.chatMounts).toBe(1);
  expect(mocks.onConversationStarted).not.toBeNull();
  await act(async () => {
    mocks.onConversationStarted?.({
      id: executionId,
      sessionId: null,
      projectId: "lp_example",
      title: "Private planning",
      provider: "codex",
      state: "running",
      updatedAt: "2026-10-16T00:00:00.000Z",
      error: null
    });
  });

  mocks.searchParams = new URLSearchParams(
    `chat=1&execution=${executionId}&agent=owner-agent&project=lp_example&teamRequest=request-1&teamRequestTeam=team-1&teamRequestVersion=1&teamReviewVersion=1&provider=codex&model=gpt-6-luna&effort=high&access=full&client=codex.default`
  );
  await act(async () => root.render(<Home />));
  await flushEffects();

  expect(
    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
      String(call[0]).includes(
        `/studio-api/managed-conversations/${executionId}/runtime`
      )
    )
  ).toBe(false);
  expect(mocks.chatMounts).toBe(1);
  expect(mocks.chatUnmounts).toBe(0);
  expect(container.querySelector('[data-testid="live-chat"]')).not.toBeNull();
});

it.each([
  {
    name: "owner-bound Team executions",
    response: {
      teamAgentRequestBinding: {
        requestId: "22345678-1234-4234-8234-123456789012",
        teamId: "32345678-1234-4234-8234-123456789012",
        agentId: "42345678-1234-4234-8234-123456789012",
        status: "accepted"
      }
    },
    status: 200,
    expectedRoute:
      "chat=1&execution=12345678-1234-4234-8234-123456789012&agent=42345678-1234-4234-8234-123456789012&teamRequest=22345678-1234-4234-8234-123456789012&teamRequestTeam=32345678-1234-4234-8234-123456789012",
    expectedError: ""
  },
  {
    name: "ordinary managed executions",
    response: { teamAgentRequestBinding: null },
    status: 200,
    expectedRoute: "chat=1&execution=12345678-1234-4234-8234-123456789012",
    expectedError: ""
  },
  {
    name: "unavailable owner binding checks",
    response: { error: { message: "Owner check unavailable" } },
    status: 503,
    expectedRoute: null,
    expectedError: "Owner check unavailable"
  },
  {
    name: "older runtime responses without binding metadata",
    response: { execution: { id: "12345678-1234-4234-8234-123456789012" } },
    status: 200,
    expectedRoute: null,
    expectedError: "The owner-authorized Team request binding is unavailable."
  }
])("checks ownership before resuming $name", async (scenario) => {
  mocks.managedRuntimeResponse = scenario.response;
  mocks.managedRuntimeStatus = scenario.status;
  mocks.searchParams = new URLSearchParams();
  await act(async () => root.render(<Home />));
  await flushEffects();

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="resume-execution"]')
      ?.click();
  });
  await flushEffects();

  if (scenario.expectedRoute) {
    expect(mocks.router.replace).toHaveBeenCalledWith(
      `/?${scenario.expectedRoute}`
    );
    expect(container.querySelector('[data-testid="live-chat"]')).toBeNull();
  } else {
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      scenario.expectedError
    );
    expect(container.querySelector('[data-testid="live-chat"]')).toBeNull();
  }
});

it("opens an explicitly known Personal root without probing it as an execution", async () => {
  const rootId = "12345678-1234-4234-8234-123456789012";
  mocks.searchParams = new URLSearchParams();
  mocks.personalConversations = [
    {
      conversationId: rootId,
      title: "Personal root",
      projectId: null,
      sourceExecutionIds: [],
      childExecutionIds: [],
      capturedSessionIds: []
    }
  ];
  await act(async () => root.render(<Home />));
  await flushEffects();

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="resume-execution"]')
      ?.click();
  });
  await flushEffects();

  expect(mocks.router.replace).toHaveBeenCalledWith(
    `/?chat=1&conversation=${rootId}`
  );
  expect(
    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
      String(call[0]).includes(
        `/studio-api/managed-conversations/${rootId}/runtime`
      )
    )
  ).toBe(false);
});

it("prefers owner-bound Team routing over a Personal child-to-root mapping", async () => {
  const executionId = "12345678-1234-4234-8234-123456789012";
  const personalRoot = {
    conversationId: "22345678-1234-4234-8234-123456789012",
    title: "Personal root",
    projectId: null,
    sourceExecutionIds: [executionId],
    childExecutionIds: [],
    capturedSessionIds: []
  };
  mocks.personalConversationForExecution.mockReturnValue(personalRoot);
  mocks.managedRuntimeResponse = {
    teamAgentRequestBinding: {
      requestId: "22345678-1234-4234-8234-123456789012",
      teamId: "32345678-1234-4234-8234-123456789012",
      agentId: "42345678-1234-4234-8234-123456789012",
      status: "accepted"
    }
  };
  mocks.searchParams = new URLSearchParams();
  await act(async () => root.render(<Home />));
  await flushEffects();

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="resume-execution"]')
      ?.click();
  });
  await flushEffects();

  expect(mocks.router.replace).toHaveBeenCalledWith(
    `/?chat=1&execution=${executionId}&agent=42345678-1234-4234-8234-123456789012&teamRequest=22345678-1234-4234-8234-123456789012&teamRequestTeam=32345678-1234-4234-8234-123456789012`
  );
  expect(mocks.router.replace).not.toHaveBeenCalledWith(
    `/?chat=1&conversation=${personalRoot.conversationId}`
  );
});

it("does not restore a pending owner probe after the user returns Home", async () => {
  const executionId = "12345678-1234-4234-8234-123456789012";
  let resolveRuntime!: (response: Response) => void;
  mocks.searchParams = new URLSearchParams();
  mocks.managedRuntimeGate = new Promise((resolve) => {
    resolveRuntime = resolve;
  });
  await act(async () => root.render(<Home />));
  await flushEffects();

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="resume-execution"]')
      ?.click();
  });
  await flushEffects();
  expect(container.textContent).toContain("Checking conversation ownership…");

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="go-home"]')
      ?.click();
  });
  resolveRuntime(
    Response.json({
      teamAgentRequestBinding: {
        requestId: "22345678-1234-4234-8234-123456789012",
        teamId: "32345678-1234-4234-8234-123456789012",
        agentId: "42345678-1234-4234-8234-123456789012",
        status: "accepted"
      }
    })
  );
  await flushEffects();

  expect(mocks.router.replace).toHaveBeenCalledTimes(1);
  expect(mocks.router.replace).toHaveBeenCalledWith("/");
  expect(mocks.router.replace).not.toHaveBeenCalledWith(
    expect.stringContaining(`execution=${executionId}`)
  );
});
