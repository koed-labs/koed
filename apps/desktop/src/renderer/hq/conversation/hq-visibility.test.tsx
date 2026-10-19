// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationClientUpdate,
  CollaborationRendererClient
} from "../../../collaboration/renderer-client.js";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { HqVisibilityLine } from "./HqVisibilityLine.js";
import {
  hqVisibilityIdentity,
  readHqConversationVisibility,
  useHqConversationVisibility
} from "./hq-visibility.js";

const logicalMemoryId = "00000000-0000-4000-8000-000000000105";
const source = {
  kind: "captured_session",
  logicalMemoryId,
  sessionId: "00000000-0000-4000-8000-000000000106"
} as const;
const sessionId = source.sessionId;
const otherSource = {
  kind: "captured_session",
  logicalMemoryId: "00000000-0000-4000-8000-000000000107",
  sessionId: "00000000-0000-4000-8000-000000000108"
} as const;
const reader = (
  grants: unknown[] = [],
  pages: Array<{ shares: unknown[]; nextCursor: string | null }> = [
    { shares: [], nextCursor: null }
  ]
) => {
  const listOwnedSharedMemoryGrants = vi.fn(async () => grants);
  const listOwnedShares = vi.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error("Unexpected page");
    return page;
  });
  return {
    client: {
      listOwnedSharedMemoryGrants,
      listOwnedShares,
      subscribe: () => () => undefined
    } as unknown as CollaborationRendererClient,
    listOwnedSharedMemoryGrants,
    listOwnedShares
  };
};

const eventReader = () => {
  const pending: Array<(grants: unknown[]) => void> = [];
  type Listener = Parameters<CollaborationRendererClient["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const listOwnedSharedMemoryGrants = vi.fn(
    () => new Promise<unknown[]>((resolve) => pending.push(resolve))
  );
  const listOwnedShares = vi.fn(async () => ({
    shares: [],
    nextCursor: null
  }));
  const client = {
    listOwnedSharedMemoryGrants,
    listOwnedShares,
    subscribe: vi.fn((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    })
  } as unknown as CollaborationRendererClient;
  const emit = (update: CollaborationClientUpdate) => {
    for (const listener of listeners)
      void listener({} as CollaborationSnapshot, update);
  };
  return { client, pending, listeners, listOwnedSharedMemoryGrants, emit };
};

const shareChanged: CollaborationClientUpdate = {
  kind: "realtime",
  realtimeUpdate: {
    type: "owned_share_status_changed",
    pendingShareId: "00000000-0000-4000-8000-000000000109",
    sourceTitle: "Conversation",
    state: "activated",
    stage: "complete",
    workspaceAccessState: "active",
    sourceUpdateState: "active",
    redactedFailureCode: null
  }
};

describe("HQ Conversation visibility", () => {
  it("requires one coherent route, detail and runtime source identity", () => {
    const current = { sessionId, logicalMemoryId };
    expect(hqVisibilityIdentity(current, current, sessionId)).toEqual(current);
    expect(
      hqVisibilityIdentity(
        current,
        { ...current, sessionId: otherSource.sessionId },
        otherSource.sessionId
      )
    ).toBeNull();
    expect(
      hqVisibilityIdentity(current, current, otherSource.sessionId)
    ).toBeNull();
    expect(
      hqVisibilityIdentity(
        current,
        { ...current, logicalMemoryId: otherSource.logicalMemoryId },
        sessionId
      )
    ).toBeNull();
    expect(
      hqVisibilityIdentity(
        { sessionId, logicalMemoryId: null },
        current,
        sessionId
      )
    ).toEqual(current);
    expect(
      hqVisibilityIdentity(
        { sessionId: null, logicalMemoryId },
        { sessionId, logicalMemoryId: null },
        sessionId
      )
    ).toBeNull();
  });

  it("claims Just me only after complete grant and owned-share reads", async () => {
    const { client, listOwnedShares } = reader(
      [{ source: otherSource, lifecycle: "active" }],
      [
        {
          shares: [
            {
              kind: "grant",
              grant: { source: otherSource },
              summary: { sourceSessionId: otherSource.sessionId }
            }
          ],
          nextCursor: "next"
        },
        { shares: [], nextCursor: null }
      ]
    );
    expect(
      await readHqConversationVisibility(client, logicalMemoryId, sessionId)
    ).toBe("personal-private");
    expect(listOwnedShares).toHaveBeenNthCalledWith(2, {
      cursor: "next",
      limit: 100,
      history: false
    });
  });

  it("withholds private label for an active grant or a pending share", async () => {
    const active = reader([{ source, lifecycle: "active" }]);
    expect(
      await readHqConversationVisibility(
        active.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    expect(active.listOwnedShares).not.toHaveBeenCalled();

    const pending = reader(
      [],
      [
        {
          shares: [
            {
              kind: "pending",
              pendingShare: { source, state: "needs_attention" },
              summary: { sourceSessionId: null }
            }
          ],
          nextCursor: null
        }
      ]
    );
    expect(
      await readHqConversationVisibility(
        pending.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
  });

  it("withholds privacy for unavailable grants and conflicting source aliases", async () => {
    for (const grantSource of [
      source,
      { ...source, sessionId: otherSource.sessionId },
      { ...otherSource, sessionId }
    ]) {
      const { client } = reader([
        { source: grantSource, lifecycle: "unavailable" }
      ]);
      expect(
        await readHqConversationVisibility(client, logicalMemoryId, sessionId)
      ).toBe("unverified");
    }
    for (const [shareSource, sourceSessionId] of [
      [source, otherSource.sessionId],
      [otherSource, sessionId]
    ] as const) {
      const { client } = reader(
        [],
        [
          {
            shares: [
              {
                kind: "pending",
                pendingShare: { source: shareSource, state: "needs_attention" },
                summary: { sourceSessionId }
              }
            ],
            nextCursor: null
          }
        ]
      );
      expect(
        await readHqConversationVisibility(client, logicalMemoryId, sessionId)
      ).toBe("unverified");
    }
  });

  it("does not claim privacy from failed or incomplete reads", async () => {
    const failure = reader();
    failure.listOwnedSharedMemoryGrants.mockRejectedValue(new Error("offline"));
    expect(
      await readHqConversationVisibility(
        failure.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    const cycle = reader(
      [],
      [
        {
          shares: [
            {
              kind: "grant",
              grant: { source: otherSource },
              summary: { sourceSessionId: otherSource.sessionId }
            }
          ],
          nextCursor: "same"
        },
        {
          shares: [
            {
              kind: "grant",
              grant: { source: otherSource },
              summary: { sourceSessionId: otherSource.sessionId }
            }
          ],
          nextCursor: "same"
        }
      ]
    );
    expect(
      await readHqConversationVisibility(
        cycle.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    const shareFailure = reader();
    shareFailure.listOwnedShares.mockRejectedValue(new Error("offline"));
    expect(
      await readHqConversationVisibility(
        shareFailure.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    const incomplete = reader([], [{ shares: [], nextCursor: "next" }]);
    expect(
      await readHqConversationVisibility(
        incomplete.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
  });

  it("stops at its bounded pagination limit without claiming privacy", async () => {
    const { client, listOwnedShares } = reader();
    listOwnedShares.mockImplementation(async () => ({
      shares: [
        {
          kind: "grant",
          grant: { source: otherSource },
          summary: { sourceSessionId: otherSource.sessionId }
        }
      ],
      nextCursor: `page-${listOwnedShares.mock.calls.length}`
    }));
    expect(
      await readHqConversationVisibility(client, logicalMemoryId, sessionId)
    ).toBe("unverified");
    expect(listOwnedShares).toHaveBeenCalledTimes(100);
  });

  it("renders a line only for the established personal-private contract", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<HqVisibilityLine visibility="personal-private" />)
    );
    expect(host.textContent).toBe("Just me");
    expect(host.querySelector("svg")).not.toBeNull();
    await act(async () =>
      root.render(<HqVisibilityLine visibility="unverified" />)
    );
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    host.remove();
  });

  it("drops a prior private result immediately on disconnection or identity change", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const { client } = reader();
    function Host({
      connected,
      sessionId
    }: {
      connected: boolean;
      sessionId: string;
    }) {
      const visibility = useHqConversationVisibility({
        client,
        logicalMemoryId,
        sessionId,
        ownerId: "owner-1",
        revision: "revision-1",
        connected
      });
      return <HqVisibilityLine visibility={visibility} />;
    }
    await act(async () =>
      root.render(<Host connected sessionId="session-1" />)
    );
    expect(host.textContent).toBe("Just me");
    await act(async () =>
      root.render(<Host connected={false} sessionId="session-1" />)
    );
    expect(host.textContent).toBe("");
    await act(async () =>
      root.render(<Host connected sessionId="session-2" />)
    );
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    host.remove();
  });

  it("ignores a late private read after owner, session or revision changes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const pending: Array<(value: unknown[]) => void> = [];
    const client = {
      listOwnedSharedMemoryGrants: vi.fn(
        () => new Promise<unknown[]>((resolve) => pending.push(resolve))
      ),
      listOwnedShares: vi.fn(async () => ({ shares: [], nextCursor: null })),
      subscribe: () => () => undefined
    } as unknown as CollaborationRendererClient;
    function Host({
      ownerId,
      currentSessionId,
      revision,
      connected
    }: {
      ownerId: string;
      currentSessionId: string;
      revision: string;
      connected: boolean;
    }) {
      const visibility = useHqConversationVisibility({
        client,
        logicalMemoryId,
        sessionId: currentSessionId,
        ownerId,
        revision,
        connected
      });
      return <HqVisibilityLine visibility={visibility} />;
    }
    await act(async () =>
      root.render(
        <Host
          ownerId="owner-1"
          currentSessionId={sessionId}
          revision="r1"
          connected
        />
      )
    );
    await act(async () =>
      root.render(
        <Host
          ownerId="owner-2"
          currentSessionId={otherSource.sessionId}
          revision="r2"
          connected
        />
      )
    );
    await act(async () => {
      pending[0]?.([]);
    });
    expect(host.textContent).toBe("");
    await act(async () => {
      pending[1]?.([]);
    });
    expect(host.textContent).toBe("Just me");
    await act(async () =>
      root.render(
        <Host
          ownerId="owner-2"
          currentSessionId={otherSource.sessionId}
          revision="r3"
          connected
        />
      )
    );
    expect(host.textContent).toBe("");
    await act(async () =>
      root.render(
        <Host
          ownerId="owner-2"
          currentSessionId={otherSource.sessionId}
          revision="r3"
          connected={false}
        />
      )
    );
    await act(async () => {
      pending[2]?.([]);
    });
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    host.remove();
  });

  it("rechecks privacy after reconnecting or returning to the same source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const pending: Array<(value: []) => void> = [];
    const client = {
      listOwnedSharedMemoryGrants: vi.fn(
        () => new Promise<[]>((resolve) => pending.push(resolve))
      ),
      listOwnedShares: vi.fn(async () => ({ shares: [], nextCursor: null })),
      subscribe: () => () => undefined
    } as unknown as CollaborationRendererClient;
    function Host({
      currentSessionId,
      connected
    }: {
      currentSessionId: string;
      connected: boolean;
    }) {
      const visibility = useHqConversationVisibility({
        client,
        logicalMemoryId,
        sessionId: currentSessionId,
        ownerId: "owner-1",
        revision: "same-revision",
        connected
      });
      return <HqVisibilityLine visibility={visibility} />;
    }
    const render = async (currentSessionId: string, connected = true) =>
      act(async () =>
        root.render(
          <Host currentSessionId={currentSessionId} connected={connected} />
        )
      );
    const release = async (index: number) =>
      act(async () => {
        pending[index]?.([]);
      });

    await render(sessionId);
    await release(0);
    expect(host.textContent).toBe("Just me");
    await render(sessionId, false);
    expect(host.textContent).toBe("");
    await render(sessionId);
    expect(host.textContent).toBe("");
    await release(1);
    expect(host.textContent).toBe("Just me");
    await render(otherSource.sessionId);
    expect(host.textContent).toBe("");
    await render(sessionId);
    expect(host.textContent).toBe("");
    await release(2);
    expect(host.textContent).toBe("");
    await release(3);
    expect(host.textContent).toBe("Just me");
    await act(async () => root.unmount());
    host.remove();
  });

  it("withholds verified privacy on share updates and recovery without a snapshot revision change", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const { client, pending, listeners, listOwnedSharedMemoryGrants, emit } =
      eventReader();
    function Host() {
      const visibility = useHqConversationVisibility({
        client,
        logicalMemoryId,
        sessionId,
        ownerId: "owner-1",
        revision: "unchanged",
        connected: true
      });
      return <HqVisibilityLine visibility={visibility} />;
    }
    await act(async () => root.render(<Host />));
    await act(async () => pending[0]?.([]));
    expect(host.textContent).toBe("Just me");

    await act(async () => emit(shareChanged));
    expect(host.textContent).toBe("");
    expect(listOwnedSharedMemoryGrants).toHaveBeenCalledTimes(2);
    await act(async () => pending[1]?.([{ source, lifecycle: "active" }]));
    expect(host.textContent).toBe("");

    await act(async () =>
      emit({ kind: "realtime", authoritativeRecovery: true })
    );
    expect(host.textContent).toBe("");
    expect(listOwnedSharedMemoryGrants).toHaveBeenCalledTimes(3);
    await act(async () => pending[2]?.([]));
    expect(host.textContent).toBe("Just me");

    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    emit(shareChanged);
    expect(listOwnedSharedMemoryGrants).toHaveBeenCalledTimes(3);
    host.remove();
  });

  it("ignores an in-flight private read superseded by a share update", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const { client, pending, listOwnedSharedMemoryGrants, emit } =
      eventReader();
    function Host() {
      const visibility = useHqConversationVisibility({
        client,
        logicalMemoryId,
        sessionId,
        ownerId: "owner-1",
        revision: "unchanged",
        connected: true
      });
      return <HqVisibilityLine visibility={visibility} />;
    }
    await act(async () => root.render(<Host />));
    await act(async () => emit(shareChanged));
    expect(listOwnedSharedMemoryGrants).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]?.([]));
    expect(host.textContent).toBe("");
    await act(async () => pending[1]?.([{ source, lifecycle: "active" }]));
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    host.remove();
  });
});
