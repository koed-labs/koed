import { describe, expect, it, vi } from "vitest";
import type {
  CollaborationSelection,
  CollaborationSnapshot,
  CollaborationSubscription
} from "./collaboration-contract.js";
import { CollaborationClientRuntime } from "./collaboration-client-runtime.js";

const selection = (threadId: string): CollaborationSelection => ({
  kind: "personal_channel",
  threadId
});

const snapshot = (threadId: string) =>
  ({
    selection: selection(threadId),
    view: { kind: "thread", thread: { id: threadId } }
  }) as CollaborationSnapshot;

const runtime = (input: {
  createSubscription?: (
    scope: CollaborationSubscription["scope"]
  ) => Promise<CollaborationSubscription | null>;
  releaseSubscription?: (subscriptionId: string) => Promise<void>;
  now?: () => number;
}) =>
  new CollaborationClientRuntime({
    createSubscription: input.createSubscription ?? (async () => null),
    releaseSubscription: input.releaseSubscription ?? (async () => undefined),
    preferredSelection: () => ({ selection: null, intentGeneration: 0 }),
    selectionIdentity: (value) =>
      value.kind === "personal_channel" ? value.threadId : value.kind,
    teamIdForSelection: () => null,
    selectionCacheLimit: 2,
    selectionCacheRetentionMs: 100,
    now: input.now
  });

describe("CollaborationClientRuntime", () => {
  it("deduplicates subscriptions and releases a stale creation", async () => {
    let resolve!: (value: CollaborationSubscription) => void;
    const createSubscription = vi.fn(
      () =>
        new Promise<CollaborationSubscription>((done) => {
          resolve = done;
        })
    );
    const releaseSubscription = vi.fn(async () => undefined);
    const client = runtime({ createSubscription, releaseSubscription });
    const first = client.subscribe({ scope: "personal" });
    const duplicate = client.subscribe({ scope: "personal" });
    client.invalidateAuthority();
    resolve({
      id: "subscription",
      scope: { scope: "personal" },
      state: "active",
      version: 1,
      expiresAt: "2026-08-18T00:00:00.000Z"
    });

    await Promise.all([first, duplicate]);
    expect(createSubscription).toHaveBeenCalledOnce();
    expect(releaseSubscription).toHaveBeenCalledWith("subscription");
    expect(client.hasSubscription("subscription")).toBe(false);
  });

  it("expires, bounds, and invalidates selection views by generation", () => {
    let now = 0;
    const client = runtime({ now: () => now });
    client.rememberSelectionView(snapshot("one"));
    now = 1;
    client.rememberSelectionView(snapshot("two"));
    now = 2;
    expect(client.selectionView(selection("one"))).not.toBeNull();
    now = 3;
    client.rememberSelectionView(snapshot("three"));

    expect(client.selectionView(selection("two"))).toBeNull();
    client.invalidateAuthority();
    expect(client.selectionView(selection("one"))).toBeNull();
  });

  it("tracks revocation across later non-revoking generations", () => {
    const client = runtime({});
    const before = client.authorityGeneration();
    client.invalidateAuthority({ revoked: true });
    const after = client.authorityGeneration();
    client.invalidateAuthority();

    expect(client.authorityWasRevokedSince(before)).toBe(true);
    expect(client.authorityWasRevokedSince(after)).toBe(false);
  });
});
