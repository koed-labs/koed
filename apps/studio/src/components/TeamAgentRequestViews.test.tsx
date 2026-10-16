// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
import {
  TeamAgentRequestReviewPanel,
  TeamChannelAgentRequests
} from "./TeamAgentRequestViews";
import type { TeamAgentRequestsClient } from "@/lib/team-agent-requests-client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const teamId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const executionId = "33333333-3333-4333-8333-333333333333";
const ownerId = "44444444-4444-4444-8444-444444444444";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const request = (
  overrides: Partial<TeamAgentRequest> = {}
): TeamAgentRequest => ({
  id: requestId,
  teamId,
  teamProjectId: "55555555-5555-4555-8555-555555555555",
  channelId: "66666666-6666-4666-8666-666666666666",
  requestMessageId: "77777777-7777-4777-8777-777777777777",
  originRootMessageId: null,
  requesterId: "88888888-8888-4888-8888-888888888888",
  requesterName: "Maya",
  ownerId,
  ownerName: "Alex",
  agentId: "99999999-9999-4999-8999-999999999999",
  agentName: "Analyst",
  status: "awaiting_owner",
  jobId: null,
  jobStatus: null,
  executionStatus: null,
  outcomeMessageId: null,
  version: 1,
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  canWithdraw: false,
  canReview: true,
  ...overrides
});

async function mount(
  props: React.ComponentProps<typeof TeamAgentRequestReviewPanel>
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TeamAgentRequestReviewPanel {...props} />);
  });
  return container;
}

async function mountChannelRequests(
  props: React.ComponentProps<typeof TeamChannelAgentRequests>
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TeamChannelAgentRequests {...props} />);
  });
  return container;
}

it("refreshes native execution status without exposing owner-private actions to the requester", async () => {
  let visibleRequest = request({
    status: "accepted",
    version: 2,
    executionStatus: "queued",
    canReview: false
  });
  const listRequests = vi.fn(async () => ({
    teamId,
    requests: [visibleRequest],
    nextCursor: null,
    serverTime: "2026-10-15T10:00:00.000Z"
  }));
  const client = { listRequests } as unknown as TeamAgentRequestsClient;
  const props = {
    teamId,
    channelId: visibleRequest.channelId,
    viewerId: visibleRequest.requesterId,
    authorityKey: `${teamId}:${visibleRequest.requesterId}`,
    refreshRevision: 0,
    client,
    onAuthorizationLost: vi.fn(),
    onReview: vi.fn(),
    onViewWork: vi.fn()
  } satisfies React.ComponentProps<typeof TeamChannelAgentRequests>;

  const view = await mountChannelRequests(props);
  await vi.waitFor(() => expect(listRequests).toHaveBeenCalledTimes(1));
  expect(view.textContent).toContain("Accepted · queued");
  expect(view.textContent).not.toContain("Continue private chat");
  expect(view.textContent).not.toContain("View work");

  visibleRequest = request({
    status: "accepted",
    version: 2,
    executionStatus: "running",
    canReview: false
  });
  await act(async () => {
    root!.render(<TeamChannelAgentRequests {...props} refreshRevision={1} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(listRequests).toHaveBeenCalledTimes(2);
  expect(view.textContent).toContain("Accepted · working");
  expect(view.textContent).not.toContain("Continue private chat");
  expect(view.textContent).not.toContain("View work");

  visibleRequest = request({
    status: "accepted",
    version: 2,
    executionStatus: "succeeded",
    canReview: false
  });
  await act(async () => {
    root!.render(<TeamChannelAgentRequests {...props} refreshRevision={2} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(listRequests).toHaveBeenCalledTimes(3);
  expect(view.textContent).toContain("Completed");
  expect(view.textContent).not.toContain("Continue private chat");
  expect(view.textContent).not.toContain("View work");
});

it("keeps native acceptance behind the saved private execution and shows queued state", async () => {
  let reviewExecutionId: string | null = null;
  let visibleRequest = request();
  const decideRequest = vi.fn(async () => {
    visibleRequest = request({
      status: "accepted",
      version: 2,
      executionStatus: "queued"
    });
    return visibleRequest;
  });
  const client = {
    getReview: vi.fn(async () => ({
      teamId,
      requestId,
      executionId: reviewExecutionId,
      privateGoal: "Review the proposal and prepare the implementation.",
      version: 1
    })),
    listRequests: vi.fn(async () => ({
      teamId,
      requests: [visibleRequest],
      nextCursor: null,
      serverTime: "2026-10-14T10:00:00.000Z"
    })),
    decideRequest
  } as unknown as TeamAgentRequestsClient;
  const onAccepted = vi.fn();
  const props = {
    teamId,
    requestId,
    executionId: null,
    client,
    onAuthorizationLost: vi.fn(),
    onAccepted
  } satisfies React.ComponentProps<typeof TeamAgentRequestReviewPanel>;

  const view = await mount(props);
  expect(view.textContent).toContain(
    "Save the private brief first to unlock the private planning chat."
  );
  expect(view.textContent).toContain(
    "You can refine and save it again before accepting."
  );
  expect(view.textContent).not.toContain(
    "Send a private message to create this native conversation"
  );
  let accept = [...view.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept and assign"
  )!;
  expect(accept.disabled).toBe(true);
  expect(decideRequest).not.toHaveBeenCalled();

  reviewExecutionId = executionId;
  await act(async () => {
    root!.render(
      <TeamAgentRequestReviewPanel {...props} executionId={executionId} />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  accept = [...view.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept and assign"
  )!;
  expect(accept.disabled).toBe(false);
  await act(async () => accept.click());

  expect(decideRequest).toHaveBeenCalledWith({
    teamId,
    requestId,
    expectedVersion: 1,
    decision: "accept"
  });
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(view.textContent).toContain("Accepted · queued");
  expect(view.textContent).toContain(
    "Continue the private execution in this chat"
  );
  expect(view.textContent).not.toContain("Draft summary privately");
});

it("keeps the review mounted during polling and ignores callback identity changes", async () => {
  let tick: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation((callback) => {
    tick = callback as () => void;
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
  const savedReview = {
    teamId,
    requestId,
    executionId,
    privateGoal: "Saved brief",
    version: 2
  };
  let finishRead: ((value: typeof savedReview) => void) | undefined;
  const getReview = vi
    .fn()
    .mockResolvedValueOnce(savedReview)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    )
    .mockResolvedValue(savedReview);
  const client = {
    getReview,
    listRequests: vi.fn(async () => ({
      teamId,
      requests: [request({ status: "accepted", executionStatus: "running" })],
      nextCursor: null
    }))
  } as unknown as TeamAgentRequestsClient;
  const props = {
    teamId,
    requestId,
    executionId,
    client,
    onAuthorizationLost: vi.fn(),
    onAccepted: vi.fn(),
    onShareQuestion: vi.fn(),
    onReviewSaved: vi.fn()
  };
  const view = await mount(props);
  const question = view.querySelector("textarea")!;
  question.focus();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(question, "Unsaved private question");
    question.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    root!.render(
      <TeamAgentRequestReviewPanel
        {...props}
        onReviewSaved={vi.fn()}
        onAuthorizationLost={vi.fn()}
      />
    );
  });
  expect(getReview).toHaveBeenCalledTimes(1);
  await act(async () => tick!());
  expect(getReview).toHaveBeenCalledTimes(2);
  expect(view.querySelector("textarea")).toBe(question);
  expect(document.activeElement).toBe(question);
  expect(question.value).toBe("Unsaved private question");
  await act(async () => finishRead!(savedReview));
  expect(view.querySelector("textarea")).toBe(question);
  expect(question.value).toBe("Unsaved private question");
});

it("preserves a dirty private brief on refresh and clears actions when authority is lost", async () => {
  const savedReview = {
    teamId,
    requestId,
    executionId,
    privateGoal: "Saved brief",
    version: 2
  };
  const getReview = vi.fn().mockResolvedValue(savedReview);
  const onAuthorizationLost = vi.fn();
  const onRequestStatusChange = vi.fn();
  const client = {
    getReview,
    listRequests: vi.fn(async () => ({
      teamId,
      requests: [request()],
      nextCursor: null
    }))
  } as unknown as TeamAgentRequestsClient;
  const props = {
    teamId,
    requestId,
    executionId: null,
    client,
    onAuthorizationLost,
    onRequestStatusChange,
    onAccepted: vi.fn()
  };
  const view = await mount(props);
  const brief = view.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(brief, "Unsaved revised brief");
    brief.dispatchEvent(new Event("input", { bubbles: true }));
    root!.render(
      <TeamAgentRequestReviewPanel {...props} executionId={executionId} />
    );
  });
  expect(getReview).toHaveBeenCalledTimes(2);
  expect(view.querySelector("textarea")).toBe(brief);
  expect(brief.value).toBe("Unsaved revised brief");
  getReview.mockRejectedValueOnce(
    new (
      await import("@/lib/team-agent-requests-client")
    ).TeamAgentRequestError("Access lost", 403)
  );
  await act(async () => {
    root!.render(<TeamAgentRequestReviewPanel {...props} executionId={null} />);
  });
  expect(view.querySelector("textarea")).toBeNull();
  expect(onAuthorizationLost).toHaveBeenCalledOnce();
  expect(onRequestStatusChange).toHaveBeenLastCalledWith(null);
});
