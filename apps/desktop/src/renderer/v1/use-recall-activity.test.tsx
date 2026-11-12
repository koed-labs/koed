// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PERSONAL_DESKTOP_CONTRACT_VERSION } from "@koed-labs/shared/personal-desktop";
import type {
  PersonalDesktopApi,
  RecallActivityPage,
  RecallActivityOverview
} from "@koed-labs/shared/personal-desktop";
import {
  RECALL_OVERVIEW_CHANGE_INTERVAL_MS,
  useRecallActivity
} from "./use-recall-activity.js";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const input = {
  from: "2026-01-01T00:00:00Z",
  to: "2027-01-01T00:00:00Z",
  limit: 50
};
const page = (name: string): RecallActivityPage => ({
  questions: [],
  nextCursor: null,
  asOf: name
});
const overview = {} as RecallActivityOverview;

it("coalesces changes, throttles overview reads, avoids rehydration, pauses hidden polling and clears denied data", async () => {
  vi.useFakeTimers();
  let listener: Parameters<PersonalDesktopApi["subscribe"]>[0] | undefined;
  const unsubscribe = vi.fn();
  const list = vi.fn(async (_input: unknown) => page("first"));
  const stats = vi.fn(async () => overview);
  const api = {
    listRecallActivity: list,
    recallActivityOverview: stats,
    subscribe: (next: typeof listener) => {
      listener = next;
      return unsubscribe;
    }
  } as unknown as PersonalDesktopApi;
  let view!: ReturnType<typeof useRecallActivity>;
  function View() {
    view = useRecallActivity(api, input, "UTC");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState
  );
  await act(async () => root!.render(<View />));
  expect(view.page?.asOf).toBe("first");
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let i = 0; i < 10; i++)
      listener?.({
        type: "ask_questions_changed",
        questionIds: ["00000000-0000-4000-8000-000000000001"],
        contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION
      });
    await vi.advanceTimersByTimeAsync(300);
  });
  // Changes re-read the cheap list at once. The overview waits for its change
  // interval, then catches up once.
  expect(list).toHaveBeenCalledTimes(2);
  expect(stats).toHaveBeenCalledTimes(1);
  expect(list.mock.calls.at(-1)).toEqual([{ ...input, hydrate: false }]);
  await act(async () => {
    listener?.({
      type: "ask_questions_changed",
      questionIds: ["00000000-0000-4000-8000-000000000001"],
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION
    });
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(list).toHaveBeenCalledTimes(3);
  expect(stats).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      RECALL_OVERVIEW_CHANGE_INTERVAL_MS - 600 - 1
    );
  });
  expect(stats).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(list).toHaveBeenCalledTimes(4);
  expect(stats).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(59_999);
  });
  expect(list).toHaveBeenCalledTimes(4);
  visibility = "hidden";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(180_000);
  });
  expect(list).toHaveBeenCalledTimes(4);
  visibility = "visible";
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(list).toHaveBeenCalledTimes(5);
  expect(stats).toHaveBeenCalledTimes(3);
  list.mockRejectedValueOnce(
    Object.assign(new Error("denied"), {
      code: "request_failed",
      retryable: false
    })
  );
  await act(async () => {
    view.refresh();
  });
  expect(view.page).toBeNull();
  expect(view.overview).toBeNull();
  expect(view.accessLost).toBe(true);
  await act(async () => {
    view.refresh();
  });
  expect(view.page?.asOf).toBe("first");
  await act(async () => root!.unmount());
  root = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("keeps an overview failure until an overview request succeeds", async () => {
  vi.useFakeTimers();
  let listener: Parameters<PersonalDesktopApi["subscribe"]>[0] | undefined;
  const list = vi.fn(async (_input: unknown) => page("first"));
  const stats = vi.fn(async () => ({ ...overview }));
  const api = {
    listRecallActivity: list,
    recallActivityOverview: stats,
    subscribe: (next: typeof listener) => {
      listener = next;
      return () => {};
    }
  } as unknown as PersonalDesktopApi;
  let view!: ReturnType<typeof useRecallActivity>;
  function View() {
    view = useRecallActivity(api, input, "UTC");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<View />));
  const loaded = view.overview;
  expect(view.overviewError).toBe(false);

  stats.mockRejectedValueOnce(
    Object.assign(new Error("unavailable"), {
      code: "request_failed",
      retryable: true
    })
  );
  await act(async () => {
    view.refresh();
  });
  expect(stats).toHaveBeenCalledTimes(2);
  expect(view.overviewError).toBe(true);
  expect(view.error).toMatch(/Refresh failed/);
  expect(view.overview).toBe(loaded);

  // A change inside the overview interval re-reads only the list. Reusing the
  // retained overview must not report the failed overview as recovered.
  await act(async () => {
    listener?.({
      type: "ask_questions_changed",
      questionIds: ["00000000-0000-4000-8000-000000000001"],
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION
    });
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(list).toHaveBeenCalledTimes(3);
  expect(stats).toHaveBeenCalledTimes(2);
  expect(view.loading).toBe(false);
  expect(view.overviewError).toBe(true);
  expect(view.error).toMatch(/Refresh failed/);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(RECALL_OVERVIEW_CHANGE_INTERVAL_MS);
  });
  expect(stats).toHaveBeenCalledTimes(3);
  expect(view.overviewError).toBe(false);
  expect(view.error).toBeNull();
  expect(view.overview).not.toBe(loaded);
});

it("discards delayed filter and account responses", async () => {
  let finish!: (page: RecallActivityPage) => void;
  const pending = new Promise<RecallActivityPage>((resolve) => {
    finish = resolve;
  });
  const oldApi = {
    listRecallActivity: vi.fn(() => pending),
    recallActivityOverview: async () => overview,
    subscribe: () => () => {}
  } as unknown as PersonalDesktopApi;
  const newApi = {
    ...oldApi,
    listRecallActivity: vi.fn(async () => page("new owner"))
  };
  let view!: ReturnType<typeof useRecallActivity>;
  function View({
    api,
    projectId
  }: {
    api: PersonalDesktopApi;
    projectId?: string;
  }) {
    view = useRecallActivity(api, { ...input, projectId }, "UTC");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<View api={oldApi} />));
  await act(async () =>
    root!.render(<View api={newApi} projectId="new-project" />)
  );
  expect(view.page?.asOf).toBe("new owner");
  await act(async () => finish(page("old owner")));
  expect(view.page?.asOf).toBe("new owner");
});
