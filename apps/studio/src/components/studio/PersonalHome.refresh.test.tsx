// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeFeedController } from "@/lib/use-home-feed";
import { PersonalHome } from "./PersonalHome";
vi.mock("./StudioSidebar", () => ({ StudioSidebar: () => null }));
vi.mock("./OwnedConversationShareDialog", () => ({
  OwnedConversationShareDialog: () => null
}));
vi.mock("./useVerifiedPersonalScope", () => ({
  useVerifiedPersonalScope: () => null
}));
vi.mock("./usePersonalRemovals", () => ({
  usePersonalRemovals: () => ({ removals: [], ready: true, loading: false })
}));
vi.mock("@/lib/studio-collaboration-client", () => ({
  StudioCollaborationClient: class {
    async loadSession() {
      throw new Error("unavailable");
    }
  }
}));
vi.mock("../SharedChatUI", () => ({
  SharedChatUI: ({ composer }: { composer: ReactNode }) => composer
}));
vi.mock("../ChatComposer", () => ({
  ChatComposer: ({
    value,
    onChange
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => <textarea value={value} onChange={(e) => onChange(e.target.value)} />
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let fail: boolean;
let feedRefresh: ReturnType<typeof vi.fn>;
const metadata = {
  state: "ready",
  fetchedAt: "2026-10-04T10:00:00Z",
  scopeKey: "http://127.0.0.1:43300|owner",
  message: null,
  warnings: [],
  coverage: { executions: true, requests: false, recents: true },
  executions: [],
  requests: [],
  recents: []
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fail = false;
  feedRefresh = vi.fn().mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (fail) return new Response("offline", { status: 503 });
      if (String(input).includes("launch-options"))
        return Response.json({
          instances: [
            {
              ready: true,
              instanceId: "local",
              driverId: "codex",
              models: [{ id: "test-model" }]
            }
          ]
        });
      return Response.json(metadata);
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
  vi.useRealTimers();
});
async function mount() {
  const homeFeed = {
    snapshot: null,
    state: "ready",
    refreshing: false,
    mutationError: null,
    pendingItemIds: new Set(),
    loadingSources: new Set(),
    canMutate: true,
    refresh: feedRefresh,
    loadMore: vi.fn(),
    setCleared: vi.fn()
  } as HomeFeedController;
  await act(async () =>
    root.render(
      <PersonalHome
        canCreateLocalProject={false}
        onStartChat={vi.fn()}
        onResumeChat={vi.fn()}
        homeFeed={homeFeed}
        onOpenHomeItem={vi.fn()}
      />
    )
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const refreshButton = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Refresh"
  );
it("hides Refresh when healthy, exposes it on automatic failure, and recovers manually without losing the draft", async () => {
  await mount();
  expect(refreshButton()).toBeUndefined();
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    const prompt = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "What should I work on next?"
    )!;
    prompt.click();
  });
  expect(textarea.value).toBe("What should I work on next?");
  fail = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(refreshButton()).toBeDefined();
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("What should I work on next?");
  fail = false;
  await act(async () => refreshButton()!.click());
  expect(refreshButton()).toBeUndefined();
  expect(textarea.value).toBe("What should I work on next?");
});
it("also exposes Refresh when only the activity refresh fails", async () => {
  await mount();
  feedRefresh.mockResolvedValue(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(refreshButton()).toBeDefined();
});
