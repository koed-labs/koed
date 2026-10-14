// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PublicSquarePage,
  PublicSquarePublication,
  TeamProjectMemberConnection
} from "@koed/shared/public-square";
import {
  PublicSquareRequestError,
  type PublicSquareClient
} from "./public-square-client";
import { usePublicSquare } from "./use-public-square";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const teamId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const publication: PublicSquarePublication = {
  id: "33333333-3333-4333-8333-333333333333",
  source: "native_command",
  jobId: null,
  agentId: "44444444-4444-4444-8444-444444444444",
  agentName: "Review agent",
  ownerId: "55555555-5555-4555-8555-555555555555",
  ownerName: "Ari",
  projectId,
  projectName: "Koed",
  ownerExecutionId: null,
  status: "running",
  lastKnownStatus: null,
  phase: null,
  phaseObservedAt: null,
  publishedAt: "2026-10-01T10:00:00.000Z",
  startedAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  completedAt: null,
  lastSeenAt: "2026-10-01T10:00:00.000Z",
  waitingOn: null,
  ownerLeftTeam: false,
  sharedBrief: null,
  version: 1,
  canEditBrief: false,
  canRemoveRetainedBrief: false
};

const page = (
  item: PublicSquarePublication = publication,
  serverTime = "2026-10-01T10:00:01.000Z"
): PublicSquarePage => ({
  teamId,
  items: [item],
  idleAgents: [],
  nextCursor: null,
  serverTime
});

function mockClient(list: (team: string) => Promise<PublicSquarePage>) {
  const connection: TeamProjectMemberConnection = {
    teamId,
    teamProjectId: projectId,
    localProjectId: "local-project",
    connectedAt: "2026-10-01T10:00:00.000Z",
    version: 1
  };
  const listMock = vi.fn(list);
  const getConnectionMock = vi.fn(async () => connection);
  return {
    client: {
      list: listMock,
      getConnection: getConnectionMock,
      setConnection: vi.fn(),
      getBriefDraft: vi.fn(),
      setBrief: vi.fn(),
      unshareProject: vi.fn()
    } as unknown as PublicSquareClient,
    list: listMock,
    getConnection: getConnectionMock
  };
}

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof usePublicSquare> | null = null;
let hidden = false;
let online = true;

function Harness({
  client,
  pollEnabled = true
}: {
  client: PublicSquareClient;
  pollEnabled?: boolean;
}) {
  const value = usePublicSquare({
    client,
    scope: {
      backendId: "https://account.example",
      principalUserId: publication.ownerId,
      teamId
    },
    projects: [{ id: projectId, name: "Koed" }],
    localProjects: [],
    enabled: true,
    pollEnabled
  });
  useEffect(() => {
    current = value;
  }, [value]);
  return null;
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(client: PublicSquareClient, pollEnabled = true) {
  await act(async () =>
    root.render(<Harness client={client} pollEnabled={pollEnabled} />)
  );
  await tick(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  online = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  current = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("refreshes native current status every 30 seconds without reloading project connections", async () => {
  let listCount = 0;
  const { client, list, getConnection } = mockClient(async () => {
    listCount += 1;
    return page(
      listCount === 1
        ? publication
        : {
            ...publication,
            status: "offline",
            lastKnownStatus: "running",
            updatedAt: "2026-10-01T10:00:30.000Z"
          },
      `2026-10-01T10:00:${String(listCount).padStart(2, "0")}.000Z`
    );
  });
  await mount(client);

  // The first refresh loads the Project connection. A status refresh may run
  // immediately on entry to the visible-current-work polling lifecycle.
  expect(list).toHaveBeenCalledTimes(2);
  expect(getConnection).toHaveBeenCalledTimes(1);
  expect(current?.items[0]?.status).toBe("offline");

  await tick(29_999);
  expect(list).toHaveBeenCalledTimes(2);
  await tick(1);
  expect(list).toHaveBeenCalledTimes(3);
  expect(getConnection).toHaveBeenCalledTimes(1);

  // A state update from running to offline must not restart the timer at zero.
  await tick(0);
  expect(list).toHaveBeenCalledTimes(3);
});

it("removes a current card and stops polling when the authoritative page omits it", async () => {
  let listCount = 0;
  const { client, list, getConnection } = mockClient(async () => {
    listCount += 1;
    return listCount === 1
      ? page()
      : {
          ...page(publication, "2026-10-01T10:01:00.000Z"),
          items: []
        };
  });
  await mount(client);

  expect(current?.items).toEqual([]);
  expect(list).toHaveBeenCalledTimes(2);
  expect(getConnection).toHaveBeenCalledTimes(1);

  await tick(120_000);
  expect(list).toHaveBeenCalledTimes(2);
  expect(current?.items).toEqual([]);
});

it("keeps the initial feed read but skips status cadence when the Square panel is closed", async () => {
  const { client, list, getConnection } = mockClient(async () => page());
  await mount(client, false);

  expect(current?.state).toBe("ready");
  expect(current?.items).toEqual([publication]);
  expect(list).toHaveBeenCalledOnce();
  expect(getConnection).toHaveBeenCalledOnce();

  await tick(120_000);
  expect(list).toHaveBeenCalledOnce();
  expect(getConnection).toHaveBeenCalledOnce();
});

it("pauses while hidden or offline and refreshes when the page wakes", async () => {
  const { client, list } = mockClient(async () => page());
  await mount(client);
  const baseline = list.mock.calls.length;
  expect(baseline).toBeGreaterThanOrEqual(2);

  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await tick(60_000);
  expect(list).toHaveBeenCalledTimes(baseline);

  hidden = false;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(list).toHaveBeenCalledTimes(baseline + 1);

  online = false;
  window.dispatchEvent(new Event("offline"));
  await tick(60_000);
  expect(list).toHaveBeenCalledTimes(baseline + 1);

  online = true;
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(list).toHaveBeenCalledTimes(baseline + 2);
});

it("clears the Team feed on status-poll authorization loss and stops polling", async () => {
  let listCount = 0;
  const onAuthorizationLost = vi.fn();
  const { client, list } = mockClient(async () => {
    listCount += 1;
    if (listCount > 1) throw new PublicSquareRequestError("forbidden", 403);
    return page();
  });
  await act(async () =>
    root.render(
      <HarnessWithAuthorization client={client} onLost={onAuthorizationLost} />
    )
  );
  await tick(0);

  expect(current?.state).toBe("access-lost");
  expect(current?.items).toEqual([]);
  expect(onAuthorizationLost).toHaveBeenCalledOnce();
  const callsAfterLoss = list.mock.calls.length;
  await tick(120_000);
  expect(list).toHaveBeenCalledTimes(callsAfterLoss);
});

function HarnessWithAuthorization({
  client,
  onLost
}: {
  client: PublicSquareClient;
  onLost: () => void;
}) {
  const value = usePublicSquare({
    client,
    scope: {
      backendId: "https://account.example",
      principalUserId: publication.ownerId,
      teamId
    },
    projects: [{ id: projectId, name: "Koed" }],
    localProjects: [],
    enabled: true,
    onAuthorizationLost: onLost
  });
  useEffect(() => {
    current = value;
  }, [value]);
  return null;
}
