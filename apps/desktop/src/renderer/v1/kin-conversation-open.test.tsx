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

// Mirrors App: rows come from a real store whose reads resolve when the test
// says, a missed click may start one read, retries never read, and rows count
// as loaded once the store's latest read is done.
async function setup() {
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
  const initial = store.loadProjects();
  await act(async () => root.render(<Harness />));
  await act(async () => {
    reads[0]!(without);
    await initial;
  });
  return {
    fixture,
    target,
    without,
    reads,
    store,
    opened,
    click: () => act(async () => showConversation(target)),
    capture: () => act(async () => void store.loadProjects({ silent: true })),
    resolve: (index: number, groups: typeof fixture.groups) =>
      act(async () => reads[index]!(groups)),
    unmount: async () => {
      await act(async () => root.unmount());
      mount.remove();
    }
  };
}

it("opens on the first click when a refresh was already running before it", async () => {
  const t = await setup();
  try {
    // A refresh is already running, started before the Conversation existed.
    await t.capture();
    expect(t.reads).toHaveLength(2);
    // The click misses and starts one read of its own.
    await t.click();
    expect(t.reads).toHaveLength(3);
    // The older refresh finishes without the row; it's been superseded.
    await t.resolve(1, t.without);
    expect(t.opened).toEqual([]);
    // Retries while waiting don't read.
    expect(t.reads).toHaveLength(3);
    // The click's own read brings the row in: the first click opens it.
    await t.resolve(2, t.fixture.groups);
    expect(t.opened).toEqual([t.target]);
    expect(t.reads).toHaveLength(3);
  } finally {
    await t.unmount();
  }
});

it("follows the latest read when a newer read finishes before the click's own", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const t = await setup();
  try {
    await t.click();
    expect(t.reads).toHaveLength(2);
    // A capture starts a newer read, which finishes first without the row.
    await t.capture();
    await t.resolve(2, t.without);
    expect(t.store.current().reading).toBe(false);
    // The click's older read is discarded, and its wait expires.
    await t.resolve(1, t.fixture.groups);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(t.opened).toEqual([]);
    // A later capture that brings the row in doesn't revive the old click.
    await t.capture();
    await t.resolve(3, t.fixture.groups);
    expect(t.opened).toEqual([]);
    // A fresh click opens it without another read.
    await t.click();
    expect(t.opened).toEqual([t.target]);
    expect(t.reads).toHaveLength(4);
  } finally {
    await t.unmount();
  }
});

it("starts at most one read per click; retries only check the rows", async () => {
  const t = await setup();
  try {
    await t.click();
    expect(t.reads).toHaveLength(2);
    // Rows changing while the click waits re-check them without reading.
    await t.capture();
    await t.resolve(2, t.without);
    await t.capture();
    await t.resolve(3, t.without);
    expect(t.reads).toHaveLength(4);
    // Retries go through openKinConversation with refresh: false.
    expect(
      openKinConversation({
        sessionId: t.target,
        groups: [],
        open: () => {},
        refresh: () => {
          throw new Error("retries must not read");
        },
        options: { refresh: false }
      })
    ).toBe(false);
    await t.resolve(1, t.without);
  } finally {
    await t.unmount();
  }
});
