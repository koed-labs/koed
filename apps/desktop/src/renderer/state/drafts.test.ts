import { describe, expect, it, vi } from "vitest";
import {
  DraftStore,
  draftAuthorityKey,
  utf8ByteLength,
  type DraftAuthority
} from "./drafts.js";

const team = (overrides: Partial<DraftAuthority> = {}): DraftAuthority => ({
  scope: "team",
  backendId: "backend",
  principalId: "principal",
  teamId: "team",
  workspaceId: "workspace",
  threadId: "thread",
  ...overrides
});

describe("DraftStore", () => {
  it("keeps authorized thread drafts in memory by full authority", () => {
    const store = new DraftStore();
    const first = team();
    const second = team({ threadId: "second" });
    store.set(first, "First draft");
    store.set(second, "Second draft");

    expect(store.get(first)).toBe("First draft");
    expect(store.get(second)).toBe("Second draft");
    expect(draftAuthorityKey(first)).not.toBe(draftAuthorityKey(second));
  });

  it("purges a same-thread draft when posting authority is lost", () => {
    const store = new DraftStore();
    const authority = team();
    store.set(authority, "Must not survive");
    store.reconcileAuthorized(() => false);

    expect(store.get(authority)).toBe("");
    expect(store.size).toBe(0);
  });

  it("purges only the changed backend or principal", () => {
    const store = new DraftStore();
    const current = team();
    const stale = team({ backendId: "old-backend" });
    store.set(current, "Current");
    store.set(stale, "Stale");
    store.reconcileAuthorized(
      (authority) =>
        authority.scope === "personal" ||
        (authority.backendId === "backend" &&
          authority.principalId === "principal")
    );

    expect(store.get(current)).toBe("Current");
    expect(store.get(stale)).toBe("");
  });

  it("notifies only when stored state changes", () => {
    const listener = vi.fn();
    const store = new DraftStore();
    const unsubscribe = store.subscribe(listener);
    const authority = team();
    store.set(authority, "Draft");
    store.purge(authority);
    store.purge(authority);
    unsubscribe();
    store.set(authority, "Ignored");

    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("utf8ByteLength", () => {
  it.each([
    ["Koed", 4],
    ["é", 2],
    ["ทีม", 9],
    ["🙂", 4]
  ])("measures UTF-8 bytes for %s", (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });
});
