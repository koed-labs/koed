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
  readHqPublishedVisibility,
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
  const teamId = "00000000-0000-4000-8000-000000000201";
  const workspaceId = "00000000-0000-4000-8000-000000000202";
  const projectId = "00000000-0000-4000-8000-000000000203";
  const grantId = "00000000-0000-4000-8000-000000000204";
  const person = (
    id: string,
    displayName: string,
    access: "read" | "disabled" = "read"
  ) => ({
    id,
    displayName,
    membershipState: "enabled",
    management: { workspaceAccess: [{ workspaceId, access }] }
  });
  const snapshot = (revision = "r1") => ({
    snapshotRevision: revision,
    connection: { state: "live", backendId: "team-backend" },
    navigation: {
      personalOwner: { id: "owner" },
      teamPrincipal: { id: "owner" },
      teams: [
        {
          id: teamId,
          name: "Koed team",
          lifecycle: "active",
          workspaces: [
            { id: workspaceId, name: "Koed project", lifecycle: "active" }
          ],
          people: [
            person("owner", "Me"),
            person("lena", "Lena"),
            person("omar", "Omar")
          ]
        }
      ]
    }
  });
  const publishedGrant = {
    id: grantId,
    source,
    lifecycle: "active",
    mode: "continuous" as const,
    frozenAt: null,
    audience: [
      { userId: "owner", displayName: "Me" },
      { userId: "lena", displayName: "Lena" },
      { userId: "omar", displayName: "Omar" }
    ],
    teamId,
    workspaceId,
    activationRepresentation: "lcm_leaves",
    maximumFidelity: "lcm_leaves"
  };
  const publishedShare = {
    kind: "grant",
    grant: publishedGrant,
    sourceAccess: null,
    summary: {
      sourceSessionId: sessionId,
      workspaceContentAccess: "available",
      lastReadyRevision: 1
    }
  };
  const linked = {
    personalProjectId: projectId,
    teamBackendId: "team-backend",
    workspaceProjectId: projectId,
    teamWorkspaceId: workspaceId,
    version: 1
  };
  const publishedReader = (
    grant: Record<string, unknown> = publishedGrant,
    share: Record<string, unknown> = publishedShare
  ) => {
    let current = snapshot();
    const client = {
      current: () => current,
      listOwnedSharedMemoryGrants: vi.fn(async () => [grant]),
      listOwnedShares: vi.fn(async () => ({
        shares: [share],
        nextCursor: null
      })),
      subscribe: () => () => undefined
    } as unknown as CollaborationRendererClient;
    return {
      client,
      setSnapshot: (value: ReturnType<typeof snapshot>) => {
        current = value;
      }
    };
  };

  it("shows only a published exact summary grant and current Project audience", async () => {
    const { client } = publishedReader();
    const projectsApi = {
      sharedChatStatus: vi.fn(async () => "shared" as const),
      sharedMembers: vi.fn(async () => ({
        projectId,
        version: 1,
        people: [
          {
            teamMemberId: "owner-member",
            displayName: "Me",
            access: "write" as const
          },
          {
            teamMemberId: "lena-member",
            displayName: "Lena",
            access: "read" as const
          },
          {
            teamMemberId: "omar-member",
            displayName: "Omar",
            access: "read" as const
          }
        ]
      }))
    };
    expect(
      await readHqPublishedVisibility(
        client,
        logicalMemoryId,
        sessionId,
        linked,
        projectsApi
      )
    ).toEqual({
      kind: "shared-summary",
      label: "Visible to Koed team (summaries)",
      people: ["Lena", "Omar"],
      destination: "Koed project"
    });
    expect(projectsApi.sharedChatStatus).toHaveBeenCalledWith(
      projectId,
      sessionId
    );
    expect(projectsApi.sharedMembers).not.toHaveBeenCalled();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <HqVisibilityLine
          visibility={{
            kind: "shared-summary",
            label: "Visible to Koed team (summaries)",
            people: ["Lena", "Omar"],
            destination: "Koed project"
          }}
        />
      )
    );
    expect(
      host.querySelector(".hq-composer__visibility")?.getAttribute("title")
    ).toBe("Lena, Omar");
    await act(async () => root.unmount());
  });

  it("uses the exact Workspace audience for an ordinary owner, including readers outside the Project roster", async () => {
    const exactGrant = {
      ...publishedGrant,
      audience: [
        { userId: "owner", displayName: "Me" },
        { userId: "lena", displayName: "Lena" },
        { userId: "outsider", displayName: "Maya" }
      ]
    };
    const { client, setSnapshot } = publishedReader(exactGrant);
    const ordinary = snapshot();
    ordinary.navigation.teams[0]!.people =
      ordinary.navigation.teams[0]!.people.map(({ management, ...person }) => {
        void management;
        return person;
      }) as (typeof ordinary.navigation.teams)[0]["people"];
    setSnapshot(ordinary);
    const result = await readHqPublishedVisibility(
      client,
      logicalMemoryId,
      sessionId,
      linked,
      {
        sharedChatStatus: async () => "shared"
      }
    );
    expect(result).toMatchObject({
      label: "Visible to Koed team (summaries)",
      people: ["Lena", "Maya"]
    });
  });

  it("names only the enabled members of a limited direct audience", async () => {
    const { client, setSnapshot } = publishedReader({
      ...publishedGrant,
      audience: [
        { userId: "owner", displayName: "Me" },
        { userId: "lena", displayName: "Lena" }
      ]
    });
    const next = snapshot();
    next.navigation.teams[0]!.people[2] = person("omar", "Omar", "disabled");
    setSnapshot(next);
    expect(
      await readHqPublishedVisibility(client, logicalMemoryId, sessionId)
    ).toMatchObject({ label: "Visible to Lena (summaries)", people: ["Lena"] });
    expect(
      await readHqPublishedVisibility(
        client,
        logicalMemoryId,
        sessionId,
        linked,
        {
          sharedChatStatus: async () => "private"
        }
      )
    ).toMatchObject({ label: "Visible to Lena (summaries)", people: ["Lena"] });
  });

  it("uses coarse wording when a complete audience contains an unnamed reader", async () => {
    const { client } = publishedReader({
      ...publishedGrant,
      audience: [
        { userId: "owner", displayName: "Me" },
        { userId: "lena", displayName: "Lena" },
        { userId: "unnamed", displayName: "Team member" }
      ]
    });
    expect(
      await readHqPublishedVisibility(client, logicalMemoryId, sessionId)
    ).toMatchObject({
      label: "Summary shared with Koed project",
      people: []
    });
  });

  it("does not replace an explicitly unavailable owner audience with the management roster", async () => {
    const { client } = publishedReader({ ...publishedGrant, audience: null });
    expect(
      await readHqPublishedVisibility(client, logicalMemoryId, sessionId)
    ).toMatchObject({
      label: "Summary shared with Koed project",
      people: []
    });
  });

  it("withholds names and Team claims while staged, revoked or changing", async () => {
    const policyOnly = publishedReader(
      { ...publishedGrant, lifecycle: "revoked" },
      { ...publishedShare, grant: { ...publishedGrant, lifecycle: "revoked" } }
    );
    expect(
      await readHqPublishedVisibility(
        policyOnly.client,
        logicalMemoryId,
        sessionId,
        linked,
        { sharedChatStatus: async () => "shared" }
      )
    ).toBe("unverified");
    const staged = publishedReader();
    expect(
      await readHqPublishedVisibility(
        staged.client,
        logicalMemoryId,
        sessionId,
        linked,
        { sharedChatStatus: async () => "pending" }
      )
    ).toBe("unverified");
    const revoked = publishedReader(
      { ...publishedGrant, lifecycle: "revoked" },
      { ...publishedShare, grant: { ...publishedGrant, lifecycle: "revoked" } }
    );
    expect(
      await readHqPublishedVisibility(
        revoked.client,
        logicalMemoryId,
        sessionId,
        linked,
        { sharedChatStatus: async () => "private" }
      )
    ).toEqual({ kind: "private-project", teamName: "Koed team" });
    const changing = publishedReader();
    changing.client.listOwnedShares = vi.fn(async () => {
      changing.setSnapshot(snapshot("r2"));
      return { shares: [publishedShare], nextCursor: null };
    }) as unknown as CollaborationRendererClient["listOwnedShares"];
    expect(
      await readHqPublishedVisibility(
        changing.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    const switchedBackend = publishedReader();
    switchedBackend.client.listOwnedShares = vi.fn(async () => {
      switchedBackend.setSnapshot({
        ...snapshot(),
        connection: { state: "live", backendId: "other-backend" }
      });
      return { shares: [publishedShare], nextCursor: null };
    }) as unknown as CollaborationRendererClient["listOwnedShares"];
    expect(
      await readHqPublishedVisibility(
        switchedBackend.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    const wrongProfile = publishedReader();
    wrongProfile.setSnapshot({
      ...snapshot(),
      connection: { state: "live", backendId: "another-backend" }
    });
    expect(
      await readHqPublishedVisibility(
        wrongProfile.client,
        logicalMemoryId,
        sessionId,
        linked,
        { sharedChatStatus: async () => "shared" }
      )
    ).toBe("unverified");
    const sourceAccessible = publishedReader();
    sourceAccessible.client.listOwnedShares = vi.fn(async () => ({
      shares: [{ ...publishedShare, sourceAccess: { lifecycle: "active" } }],
      nextCursor: null
    })) as unknown as CollaborationRendererClient["listOwnedShares"];
    expect(
      await readHqPublishedVisibility(
        sourceAccessible.client,
        logicalMemoryId,
        sessionId
      )
    ).toBe("unverified");
    for (const retained of [
      { mode: "snapshot" as const, frozenAt: null },
      { mode: "continuous" as const, frozenAt: "2026-10-21T09:00:00.000Z" },
      { mode: "continuous" as const, frozenAt: undefined }
    ]) {
      const old = { ...publishedGrant, ...retained };
      const retainedReader = publishedReader(old, {
        ...publishedShare,
        grant: old
      });
      expect(
        await readHqPublishedVisibility(
          retainedReader.client,
          logicalMemoryId,
          sessionId,
          linked,
          { sharedChatStatus: async () => "shared" }
        )
      ).toBe("unverified");
    }
  });
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
