// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Home from "./page";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  router: { replace: vi.fn(), push: vi.fn() },
  getAgent: vi.fn(),
  chatMounts: 0,
  chatUnmounts: 0
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
    LiveAgentChat: () => {
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
  listPersonalConversations: async () => []
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
  personalConversationForExecution: () => undefined
}));
vi.mock("@/components/studio/PersonalHome", () => ({
  PersonalHome: () => null
}));
vi.mock("@/components/studio/DemoHome", () => ({ DemoHome: () => null }));
vi.mock("@/components/studio/StudioSidebar", () => ({
  StudioSidebar: () => null
}));
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
  vi.stubEnv("NEXT_PUBLIC_KOED_STUDIO_HOSTED", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
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
