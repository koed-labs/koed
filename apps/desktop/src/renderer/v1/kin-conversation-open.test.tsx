// @vitest-environment happy-dom
import { act, useCallback, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import { createProjectSourceFixture } from "../../project-source-fixture.js";
import { useDesktopKin } from "../floating-kin/DesktopKin.js";
import { PersonalMemoryStore } from "../state/personal-memory.js";
import { openKinConversation } from "./kin-conversation-open.js";
import type { SidebarConversation } from "./project-sidebar-model.js";

afterEach(() => {
  vi.useRealTimers();
});

// Mirrors App: rows come from the store, a miss may start one read when none
// is in flight, and rows count as loaded once the store's latest read is done.
it("follows the latest inventory read when an older read started by the click finishes last", async () => {
  const fixture = createProjectSourceFixture();
  const target = fixture.groups[0]!.threads[0]!.sessionId!;
  const without = fixture.groups.map((group) => ({
    ...group,
    threads: group.threads.filter((thread) => thread.sessionId !== target)
  }));
  const reads: Array<(groups: typeof fixture.groups) => void> = [];
  const store = new PersonalMemoryStore({
    listProjects: () =>
      new Promise<typeof fixture.groups>((resolve) => {
        reads.push(resolve);
      }),
    loadEventPage: vi.fn(async () => []),
    updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
    updateSessionPresentation: vi.fn(async () => {
      throw new Error("not used");
    }),
    subscribe: vi.fn(() => () => undefined)
  } satisfies PersonalDesktopApi);
  let showConversation: (sessionId: string) => void = () => {};
  const bridge = {
    onPresentation: (listener: (state: KinPresentation) => void) => {
      listener({ placement: "sidebar", revision: 0 });
      return () => {};
    },
    setShellVisible: vi.fn(),
    onOpenAiModels: () => () => {},
    onOpenConversation: (listener: (sessionId: string) => void) => {
      showConversation = listener;
      return () => {};
    },
    confirmPresentation: vi.fn(),
    activity: vi.fn(async () => ({
      state: "running" as const,
      overflowCount: 0,
      conversations: []
    })),
    summarize: vi.fn(async () => ({ status: "unavailable" as const })),
    preview: vi.fn(async () => null),
    latest: vi.fn(async () => ({ action: null })),
    reopen: vi.fn(async () => null),
    cancel: vi.fn(async () => {})
  } as unknown as DesktopKinBridge;
  const opened: string[] = [];
  const route = { kind: "home" };
  function Harness() {
    const snapshot = useSyncExternalStore(store.subscribe, store.current);
    const groups = snapshot.projectOrder.map((id) => ({
      conversations: (snapshot.projectsById.get(id)?.threads ?? []).map(
        (thread) => ({ sessionId: thread.sessionId }) as SidebarConversation
      )
    }));
    const open = useCallback(
      (sessionId: string, options?: { refresh?: boolean }) =>
        openKinConversation({
          sessionId,
          groups,
          open: () => opened.push(sessionId),
          reading: () => Boolean(store.current().reading),
          refresh: () => void store.loadProjects({ silent: true }),
          options
        }),
      [groups]
    );
    useDesktopKin(bridge, null, true, undefined, open, {
      route,
      rowsLoaded: !snapshot.reading && snapshot.inventoryPhase === "full"
    });
    return null;
  }
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const initial = store.loadProjects();
    await act(async () => root.render(<Harness />));
    await act(async () => {
      reads[0]!(without);
      await initial;
    });
    // The click misses and starts one read.
    await act(async () => showConversation(target));
    expect(reads).toHaveLength(2);
    // A capture starts a newer read, which finishes first without the row.
    await act(async () => void store.loadProjects({ silent: true }));
    await act(async () => reads[2]!(without));
    expect(store.current().reading).toBe(false);
    // The older read's result is discarded, and the click's wait expires.
    await act(async () => reads[1]!(fixture.groups));
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(opened).toEqual([]);
    // A later capture that brings the row in doesn't revive the old click.
    await act(async () => void store.loadProjects({ silent: true }));
    await act(async () => reads[3]!(fixture.groups));
    expect(opened).toEqual([]);
    // A fresh click opens it, and starts no read now that the row is there.
    await act(async () => showConversation(target));
    expect(opened).toEqual([target]);
    expect(reads).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("lets a fresh click start a read once the latest read has finished, even if an older one hasn't", async () => {
  const fixture = createProjectSourceFixture();
  const target = fixture.groups[0]!.threads[0]!.sessionId!;
  const without = fixture.groups.map((group) => ({
    ...group,
    threads: group.threads.filter((thread) => thread.sessionId !== target)
  }));
  const reads: Array<(groups: typeof fixture.groups) => void> = [];
  const store = new PersonalMemoryStore({
    listProjects: () =>
      new Promise<typeof fixture.groups>((resolve) => {
        reads.push(resolve);
      }),
    loadEventPage: vi.fn(async () => []),
    updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
    updateSessionPresentation: vi.fn(async () => {
      throw new Error("not used");
    }),
    subscribe: vi.fn(() => () => undefined)
  } satisfies PersonalDesktopApi);
  const refresh = () => void store.loadProjects({ silent: true });
  const missing = () =>
    openKinConversation({
      sessionId: target,
      groups: [],
      open: () => {},
      reading: () => Boolean(store.current().reading),
      refresh
    });
  // The click's read starts, then a newer read starts and finishes first.
  missing();
  void store.loadProjects({ silent: true });
  reads[1]!(without);
  await vi.waitFor(() => expect(store.current().reading).toBe(false));
  // The click's older read is still outstanding, but a fresh click may read.
  missing();
  expect(reads).toHaveLength(3);
  // While that read is in flight, another miss doesn't start a fourth.
  missing();
  expect(reads).toHaveLength(3);
  // Automatic retries never read.
  openKinConversation({
    sessionId: target,
    groups: [],
    open: () => {},
    reading: () => false,
    refresh,
    options: { refresh: false }
  });
  expect(reads).toHaveLength(3);
  reads[0]!(fixture.groups);
  reads[2]!(fixture.groups);
});
