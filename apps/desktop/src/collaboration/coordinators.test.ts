import type {
  CollaborationSelection,
  CollaborationSnapshot,
  CollaborationSubscription,
  SharedMemoryRepresentation,
  SharedMemorySourcePage
} from "@koed/shared/collaboration";
import { CollaborationClientRuntime } from "@koed/shared/collaboration-client-runtime";
import { describe, expect, it, vi } from "vitest";

import { CollaborationActionGrantProjectionStore } from "./action-grant-projection-store.js";
import { RendererEventQueue } from "./renderer-event-queue.js";
import { SharedSourceBackfillCoordinator } from "./shared-source-backfill.js";

const personal = (threadId: string): CollaborationSelection => ({
  kind: "personal_channel",
  threadId
});

const snapshot = (selection: CollaborationSelection): CollaborationSnapshot =>
  ({
    selection,
    view: {
      kind: "thread",
      thread: { id: "threadId" in selection ? selection.threadId : "notes" }
    }
  }) as CollaborationSnapshot;

const createClientRuntime = (input: {
  now?: () => number;
  createSubscription?: (
    scope: CollaborationSubscription["scope"]
  ) => Promise<CollaborationSubscription | null>;
  releaseSubscription?: (subscriptionId: string) => Promise<void>;
}) =>
  new CollaborationClientRuntime({
    createSubscription: input.createSubscription ?? (async () => null),
    releaseSubscription: input.releaseSubscription ?? (async () => undefined),
    preferredSelection: () => ({ selection: null, intentGeneration: 0 }),
    selectionIdentity: (selection) =>
      selection.kind === "personal_channel"
        ? selection.threadId
        : selection.kind,
    teamIdForSelection: () => null,
    selectionCacheLimit: 2,
    selectionCacheRetentionMs: 100,
    now: input.now
  });

describe("CollaborationClientRuntime selection views", () => {
  it("bounds cached views by recency and expires retained entries", () => {
    let now = 0;
    const runtime = createClientRuntime({ now: () => now });
    runtime.rememberSelectionView(snapshot(personal("one")));
    now = 1;
    runtime.rememberSelectionView(snapshot(personal("two")));
    now = 2;
    expect(runtime.selectionView(personal("one"))).not.toBeNull();
    now = 3;
    runtime.rememberSelectionView(snapshot(personal("three")));

    expect(runtime.selectionView(personal("two"))).toBeNull();
    expect(runtime.selectionView(personal("one"))).not.toBeNull();
    now = 103;
    expect(runtime.selectionView(personal("one"))).toBeNull();
  });

  it("deduplicates in-flight selection loads and releases completed work", async () => {
    const runtime = createClientRuntime({});
    let resolve!: (value: CollaborationSnapshot | null) => void;
    const load = vi.fn(
      () =>
        new Promise<CollaborationSnapshot | null>((done) => {
          resolve = done;
        })
    );
    const first = runtime.coordinateSelectionLoad(personal("one"), load);
    const second = runtime.coordinateSelectionLoad(personal("one"), load);

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(null);
    await first;
    await runtime.coordinateSelectionLoad(personal("one"), async () => null);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects stale cache work after the backend binding changes", async () => {
    const runtime = createClientRuntime({});
    runtime.bind({
      backendId: "backend-one",
      principalId: "principal",
      remoteUrl: "https://one.example.test",
      transportId: "desktop_ipc"
    });
    runtime.rememberSelectionView(snapshot(personal("one")));
    let resolve!: (value: CollaborationSnapshot | null) => void;
    const pending = runtime.coordinateSelectionLoad(
      personal("two"),
      () =>
        new Promise<CollaborationSnapshot | null>((done) => {
          resolve = done;
        })
    );

    expect(
      runtime.bind({
        backendId: "backend-two",
        principalId: "principal",
        remoteUrl: "https://two.example.test",
        transportId: "desktop_ipc"
      })
    ).toBe(true);
    resolve(snapshot(personal("two")));

    await expect(pending).resolves.toBeNull();
    expect(runtime.selectionView(personal("one"))).toBeNull();
  });

  it("keeps the current generation when the resolved binding is unchanged", () => {
    const runtime = createClientRuntime({});
    const binding = {
      backendId: "backend-one",
      principalId: "principal",
      remoteUrl: "https://one.example.test",
      transportId: "desktop_ipc"
    };
    runtime.bind(binding);
    const generation = runtime.authorityGeneration();

    expect(runtime.bind(binding)).toBe(false);
    expect(runtime.authorityGeneration()).toBe(generation);
  });

  it("attributes revocation only to work that started before it", () => {
    const runtime = createClientRuntime({});
    const beforeRevocation = runtime.authorityGeneration();
    runtime.invalidateAuthority({ revoked: true });
    const afterRevocation = runtime.authorityGeneration();
    runtime.invalidateAuthority();

    expect(runtime.authorityWasRevokedSince(beforeRevocation)).toBe(true);
    expect(runtime.authorityWasRevokedSince(afterRevocation)).toBe(false);
  });
});

describe("CollaborationActionGrantProjectionStore", () => {
  it("publishes a bounded projection and invalidates captured authority", () => {
    const store = new CollaborationActionGrantProjectionStore(2);
    const listener = vi.fn();
    store.subscribe(listener);
    const generation = store.authorityGeneration();
    for (const id of ["one", "two", "three"]) {
      store.publish({
        id,
        expiresAt: "2026-07-29T00:00:00.000Z",
        operation: "Test",
        retryable: false,
        state: "approved"
      });
    }

    expect(store.current().map(({ id }) => id)).toEqual(["two", "three"]);
    expect(listener).toHaveBeenCalledTimes(3);
    store.revokeAuthority();
    expect(store.authorityIsCurrent(generation)).toBe(false);
  });
});

describe("SharedSourceBackfillCoordinator", () => {
  it.each<SharedMemoryRepresentation>([
    "memory_events",
    "lcm_leaves",
    "lcm_rollups"
  ])(
    "backfills %s from the newest page until the bounded view is full",
    async (representation) => {
      const selection = {
        kind: "shared_session" as const,
        teamId: "00000000-0000-4000-8000-000000000001",
        workspaceId: "00000000-0000-4000-8000-000000000002",
        sharedSessionId: "00000000-0000-4000-8000-000000000003"
      };
      const item = (sequence: number) =>
        ({
          id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          representation,
          sequence,
          occurredAt: "2026-07-29T00:00:00.000Z",
          ...(representation === "memory_events"
            ? {
                sourceItems: [
                  {
                    id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
                    sourceKind: "agent_message",
                    occurredAt: "2026-07-29T00:00:00.000Z",
                    body: `Message ${sequence}`,
                    actorName: null,
                    toolName: null,
                    toolCallId: null
                  }
                ]
              }
            : {
                summaryText: `Summary ${sequence}`,
                sourceCount: 1,
                sourceRevision: 1
              })
        }) as SharedMemorySourcePage["items"][number];
      let source: SharedMemorySourcePage = {
        snapshotRevision: "1",
        olderCursor: "older-3",
        newerCursor: null,
        hasOlder: true,
        hasNewer: false,
        sharedSessionId: selection.sharedSessionId,
        representation,
        items: [item(3)]
      };
      const pages = [
        {
          ...source,
          olderCursor: "older-2",
          items: [item(2)]
        },
        {
          ...source,
          olderCursor: null,
          hasOlder: false,
          items: [item(1)]
        }
      ];
      const loadOlder = vi.fn(async () => pages.shift()!);
      const coordinator = new SharedSourceBackfillCoordinator();
      coordinator.start(selection, source.snapshotRevision, {
        current: () => ({
          selection,
          source,
          maximumItems: 3,
          pageLimit: 1
        }),
        loadOlder,
        apply: async (page) => {
          source = {
            ...page,
            items: [...page.items, ...source.items]
          };
        }
      });
      await vi.waitFor(() => expect(source.items).toHaveLength(3));

      expect(source.items.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
      expect(loadOlder).toHaveBeenCalledTimes(2);
      expect(loadOlder).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ cursor: "older-3", limit: 1 })
      );
    }
  );
});

describe("CollaborationClientRuntime subscriptions", () => {
  it("deduplicates scope subscriptions and rejects an attempt invalidated by reset", async () => {
    let resolve!: (subscription: CollaborationSubscription) => void;
    const create = vi.fn(
      () =>
        new Promise<CollaborationSubscription>((done) => {
          resolve = done;
        })
    );
    const unsubscribe = vi.fn(async () => undefined);
    const runtime = createClientRuntime({
      createSubscription: create,
      releaseSubscription: unsubscribe
    });
    const first = runtime.subscribe({ scope: "personal" });
    const duplicate = runtime.subscribe({ scope: "personal" });
    const reset = runtime.resetSubscriptions();
    resolve({
      id: "subscription",
      scope: { scope: "personal" },
      state: "active",
      version: 1,
      expiresAt: "2026-07-29T00:00:00.000Z"
    });
    await Promise.all([first, duplicate, reset]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.hasSubscription("subscription")).toBe(false);
    expect(unsubscribe).toHaveBeenCalledWith("subscription");
  });
});

describe("RendererEventQueue", () => {
  it("keeps retries ordered while allowing an authority event to preempt delay", async () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    const after: string[] = [];
    const queue = new RendererEventQueue<string>(
      () => ({ maxCount: 10, maxBytes: 100 }),
      async (event, attempt) => {
        applied.push(`${event}:${attempt}`);
        return event === "delivery" && attempt === 0 ? 500 : null;
      },
      vi.fn(),
      (event) => after.push(event)
    );
    queue.enqueue("delivery", 1);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("authority", 1, { prepend: true, preemptRetry: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(applied).toEqual(["delivery:0", "authority:0", "delivery:1"]);
    expect(after).toEqual(["delivery", "authority", "delivery"]);
    vi.useRealTimers();
  });

  it("clears buffered state and signals overflow once", async () => {
    const overflow = vi.fn();
    const process = vi.fn(async () => null);
    const queue = new RendererEventQueue<string>(
      () => ({ maxCount: 0, maxBytes: 0 }),
      process,
      overflow,
      vi.fn()
    );
    expect(queue.enqueue("event", 1)).toBe(false);
    expect(overflow).toHaveBeenCalledOnce();
    expect(process).not.toHaveBeenCalled();
  });
});
