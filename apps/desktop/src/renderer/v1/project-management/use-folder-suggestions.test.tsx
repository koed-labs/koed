// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import {
  createProjectManagementValidationApi,
  validationId
} from "../../../project-management-validation-api.js";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { folderHintCache } from "./folder-hint-cache.js";
import { useFolderSuggestions } from "./use-folder-suggestions.js";

function harness(count = 1) {
  const fixture = createProjectManagementValidationApi();
  const project = mergeProjectSources(fixture.inventory(), [])[0]!;
  const ids = Array.from({ length: count }, (_, index) =>
    validationId(1000 + index)
  );
  const inventory = (sessions: string[]) => [
    {
      ...project,
      threads: sessions.map((sessionId) => ({
        ...fixture.threads[0]!,
        sessionId
      }))
    }
  ];
  const root = createRoot(document.createElement("div"));
  const commits: ReturnType<typeof useFolderSuggestions>[] = [];
  function Screen({
    api,
    scopeKey,
    enabled,
    projects
  }: {
    api: PersonalDesktopApi;
    scopeKey: string;
    enabled: boolean;
    projects: ReturnType<typeof inventory>;
  }) {
    const options = { scopeKey, startDelayMs: 10, pauseMs: 30 };
    const result = useFolderSuggestions(api, projects, enabled, options);
    useLayoutEffect(() => {
      commits.push(result);
    });
    return null;
  }
  return {
    ids,
    commits,
    current: () => commits.at(-1)!,
    render: (
      api: PersonalDesktopApi,
      scopeKey = "owner-a",
      enabled = true,
      sessions = ids
    ) =>
      act(async () =>
        root.render(
          <Screen
            api={api}
            scopeKey={scopeKey}
            enabled={enabled}
            projects={inventory(sessions)}
          />
        )
      ),
    close: () => act(async () => root.unmount())
  };
}

const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
const hint = (sessionId: string, score: number): PersonalFolderHint => ({
  sessionId,
  tier: "none",
  score,
  reasons: []
});
const apiWith = (
  folderHints: NonNullable<PersonalDesktopApi["folderHints"]>
) => ({ ...createProjectManagementValidationApi().api, folderHints });

function pendingHints() {
  let resolve!: (hints: PersonalFolderHint[]) => void;
  const promise = new Promise<PersonalFolderHint[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["scope", "API", "disabled"])(
  "never exposes prior hints after changing %s",
  async (change) => {
    const ui = harness();
    const id = ui.ids[0]!;
    const folderHints = vi
      .fn()
      .mockResolvedValueOnce([hint(id, 1)])
      .mockResolvedValue([]);
    const api = apiWith(folderHints);
    const replacement = apiWith(async () => []);
    try {
      await ui.render(api);
      await tick(10);
      expect(ui.current().hints.get(id)).toEqual([hint(id, 1)]);
      const first = ui.commits.length;
      await ui.render(
        change === "API" ? replacement : api,
        change === "scope" ? "owner-b" : "owner-a",
        change !== "disabled"
      );
      await tick(10);
      expect(
        ui.commits.slice(first).every(({ hints }) => !hints.get(id)?.length)
      ).toBe(true);
      expect(ui.current().loading).toBe(false);
    } finally {
      await ui.close();
    }
  }
);

it.each(["scope", "API"])(
  "discards late responses from a replaced %s scan",
  async (change) => {
    const ui = harness(51);
    const id = ui.ids[0]!;
    const oldBatch = pendingHints();
    const folderHints = vi
      .fn()
      .mockReturnValueOnce(oldBatch.promise)
      .mockResolvedValue([]);
    const api = apiWith(folderHints);
    try {
      await ui.render(api);
      await tick(10);
      expect(folderHints).toHaveBeenCalledTimes(1);
      if (change === "scope") await ui.render(api, "owner-b");
      else await ui.render(apiWith(async () => []));
      await tick(40);
      expect(ui.current()).toMatchObject({ checked: 51, loading: false });
      await act(async () => oldBatch.resolve([hint(id, 1)]));
      await tick(30);
      expect(ui.current()).toMatchObject({ checked: 51, loading: false });
      expect(ui.current().hints.has(id)).toBe(false);
      expect(folderHints).toHaveBeenCalledTimes(change === "scope" ? 3 : 1);
    } finally {
      await ui.close();
    }
  }
);

it("forgets visible and in-flight hints when its cache is invalidated", async () => {
  const ui = harness(51);
  const oldBatch = pendingHints();
  const folderHints = vi
    .fn()
    .mockResolvedValueOnce([hint(ui.ids[0]!, 1)])
    .mockReturnValueOnce(oldBatch.promise)
    .mockResolvedValue([]);
  const api = apiWith(folderHints);
  try {
    await ui.render(api);
    await tick(40);
    expect(ui.current().hints.get(ui.ids[0]!)).toEqual([hint(ui.ids[0]!, 1)]);
    await act(async () => {
      folderHintCache.clear(api, "owner-a");
      oldBatch.resolve([hint(ui.ids[50]!, 2)]);
    });
    expect(ui.current()).toMatchObject({ checked: 0, loading: true });
    await tick(40);
    expect(ui.current()).toMatchObject({ checked: 51, loading: false });
    expect(ui.current().hints.size).toBe(0);
  } finally {
    await ui.close();
  }
});

it("keeps its original start time through inventory churn", async () => {
  const ui = harness(2);
  const [first, second] = ui.ids as [string, string];
  const folderHints = vi.fn(async () => []);
  const api = apiWith(folderHints);
  try {
    await ui.render(api);
    await tick(6);
    await ui.render(api, "owner-a", true, [second, first]);
    await tick(2);
    await ui.render(api, "owner-a", true, [second]);
    await tick(2);
    expect(folderHints).toHaveBeenCalledExactlyOnceWith({
      sessionIds: [second],
      expectedScopeKey: "owner-a"
    });
  } finally {
    await ui.close();
  }
});

it("reconciles pending work without replaying retained in-flight work", async () => {
  const ui = harness(52);
  const removedInFlight = ui.ids[0]!;
  const retained = ui.ids[1]!;
  const removedPending = ui.ids[50]!;
  const last = ui.ids[51]!;
  const added = validationId(2000);
  const first = pendingHints();
  const folderHints = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue([]);
  const api = apiWith(folderHints);
  try {
    await ui.render(api);
    await tick(10);
    await ui.render(api, "owner-a", true, [
      added,
      last,
      ...ui.ids.slice(1, 50).reverse()
    ]);
    await tick(100);
    expect(folderHints).toHaveBeenCalledTimes(1);
    await act(async () =>
      first.resolve([hint(retained, 1), hint(removedInFlight, 1)])
    );
    expect(ui.current()).toMatchObject({
      total: 51,
      checked: 49,
      loading: true
    });
    expect(ui.current().hints.get(retained)).toEqual([hint(retained, 1)]);
    expect(ui.current().hints.has(removedInFlight)).toBe(false);
    await tick(29);
    expect(folderHints).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(folderHints.mock.calls[1]![0].sessionIds).toEqual([last, added]);
    expect(
      folderHints.mock.calls.flatMap(([input]) => input.sessionIds)
    ).not.toContain(removedPending);
    expect(ui.current()).toMatchObject({
      total: 51,
      checked: 51,
      loading: false
    });
  } finally {
    await ui.close();
  }
});

it("does not count an unsuccessful batch as checked or stop scanning", async () => {
  const ui = harness(101);
  const last = ui.ids[100]!;
  const folderHints = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([hint(last, 1)]);
  try {
    await ui.render(apiWith(folderHints));
    await tick(70);
    expect(ui.current()).toMatchObject({
      total: 101,
      checked: 51,
      loading: false
    });
    expect(ui.current().hints.get(last)).toEqual([hint(last, 1)]);
  } finally {
    await ui.close();
  }
});

it("scans past 300 in paced batches and counts conversations without hints", async () => {
  const ui = harness(351);
  const folderHints = vi.fn(async ({ sessionIds }: { sessionIds: string[] }) =>
    sessionIds.includes(ui.ids[350]!) ? [hint(ui.ids[350]!, 1)] : []
  );
  try {
    await ui.render(apiWith(folderHints), "large-inventory");
    await tick(10);
    expect(ui.current()).toMatchObject({
      total: 351,
      checked: 50,
      loading: true
    });
    await tick(29);
    expect(ui.current().checked).toBe(50);
    await tick(181);
    expect(ui.current()).toMatchObject({
      total: 351,
      checked: 351,
      loading: false
    });
    expect(ui.current().hints.get(ui.ids[350]!)).toEqual([
      hint(ui.ids[350]!, 1)
    ]);
    expect(
      folderHints.mock.calls.flatMap(([{ sessionIds }]) => sessionIds)
    ).toEqual(ui.ids);
    expect(
      folderHints.mock.calls.every(
        ([{ sessionIds }]) => sessionIds.length <= 50
      )
    ).toBe(true);
  } finally {
    await ui.close();
  }
});
