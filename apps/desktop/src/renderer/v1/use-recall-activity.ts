import { useEffect, useRef, useState } from "react";
import type {
  PersonalDesktopApi,
  RecallActivityListInput,
  RecallActivityOverview,
  RecallActivityPage
} from "@koed-labs/shared/personal-desktop";

type View = {
  key: string;
  page: RecallActivityPage | null;
  overview: RecallActivityOverview | null;
  loading: boolean;
  error: string | null;
  overviewError: boolean;
  accessLost: boolean;
};
const canRetain = (error: unknown) =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "request_failed" &&
    "retryable" in error &&
    error.retryable === true
  );

export function useRecallActivity(
  api: PersonalDesktopApi | null,
  input: RecallActivityListInput,
  timezone: string
) {
  const key = JSON.stringify({ input, timezone });
  const {
    from,
    to,
    searchDomain,
    status,
    projectId,
    sessionId,
    memoryStatus,
    callerName,
    minDurationMs,
    maxDurationMs
  } = input;
  const scope = JSON.stringify({
    from,
    to,
    searchDomain,
    status,
    projectId,
    sessionId,
    memoryStatus,
    callerName,
    minDurationMs,
    maxDurationMs,
    timezone
  });
  const [view, setView] = useState<View>({
    key,
    page: null,
    overview: null,
    loading: true,
    error: null,
    overviewError: false,
    accessLost: false
  });
  const pageRef = useRef<{ key: string; value: RecallActivityPage } | null>(
    null
  );
  const overviewRef = useRef<{
    scope: string;
    value: RecallActivityOverview;
  } | null>(null);
  const refresh = useRef<() => void>(() => undefined);

  useEffect(() => {
    let active = true,
      running = false,
      queued = false,
      dirty = false;
    let failures = 0,
      lastSuccess = 0;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    if (pageRef.current?.key !== key) pageRef.current = null;
    if (overviewRef.current?.scope !== scope) overviewRef.current = null;

    const readPage = async () => {
      const previous = pageRef.current?.value;
      const previousById = new Map(
        previous?.questions.map((row) => [row.id, row])
      );
      let next = await api!.listRecallActivity!({
        ...input,
        hydrate: !previous
      });
      const missing = next.questions.filter(
        (row) =>
          row.query === null &&
          previousById.get(row.id)?.updatedAt !== row.updatedAt
      );
      if (missing.length)
        next = await api!.listRecallActivity!({
          ...input,
          hydrate: true,
          contentIds: missing.map((row) => row.id)
        });
      const questions = next.questions.map((row) => ({
        ...row,
        query:
          row.query ??
          (previousById.get(row.id)?.updatedAt === row.updatedAt
            ? previousById.get(row.id)!.query
            : null)
      }));
      // A second membership change during hydration gets one bounded full read.
      return questions.some((row) => row.query === null)
        ? api!.listRecallActivity!({ ...input, hydrate: true })
        : { ...next, questions };
    };
    const schedulePoll = () => {
      clearTimeout(poll);
      if (active && visible())
        poll = setTimeout(
          () => void run(true),
          Math.min(300_000, 60_000 * 2 ** failures)
        );
    };
    const run = async (refreshOverview: boolean) => {
      if (!active) return;
      if (!visible()) {
        dirty = true;
        return;
      }
      if (running) {
        queued = true;
        return;
      }
      if (!api?.listRecallActivity || !api.recallActivityOverview) {
        pageRef.current = null;
        overviewRef.current = null;
        setView({
          key,
          page: null,
          overview: null,
          loading: false,
          error:
            "Recall activity is unavailable. Connect to your memory backend.",
          overviewError: true,
          accessLost: true
        });
        return;
      }
      running = true;
      dirty = false;
      clearTimeout(poll);
      setView({
        key,
        page: pageRef.current?.value ?? null,
        overview: overviewRef.current?.value ?? null,
        loading: true,
        error: null,
        overviewError: false,
        accessLost: false
      });
      const results = await Promise.allSettled([
        readPage(),
        refreshOverview || !overviewRef.current
          ? api.recallActivityOverview({
              from,
              to,
              searchDomain,
              status,
              projectId,
              sessionId,
              memoryStatus,
              callerName,
              minDurationMs,
              maxDurationMs,
              timezone,
              bucket:
                Date.parse(to) - Date.parse(from) <= 25 * 3_600_000
                  ? "hour"
                  : undefined
            })
          : Promise.resolve(overviewRef.current.value)
      ]);
      if (!active) return;
      running = false;
      const [pageResult, overviewResult] = results;
      const lost = results.some(
        (result) => result.status === "rejected" && !canRetain(result.reason)
      );
      const failed = results.some((result) => result.status === "rejected");
      failures = failed ? Math.min(3, failures + 1) : 0;
      if (lost) {
        pageRef.current = null;
        overviewRef.current = null;
      } else {
        if (pageResult.status === "fulfilled")
          pageRef.current = { key, value: pageResult.value };
        if (overviewResult.status === "fulfilled")
          overviewRef.current = { scope, value: overviewResult.value };
      }
      if (!failed) lastSuccess = Date.now();
      setView({
        key,
        page: pageRef.current?.value ?? null,
        overview: overviewRef.current?.value ?? null,
        loading: false,
        accessLost: lost,
        error: lost
          ? "Recall activity is unavailable or your access has changed. Refresh after reconnecting."
          : failed
            ? "Refresh failed. Previously loaded results are shown with their recorded freshness."
            : null,
        overviewError: overviewResult.status === "rejected"
      });
      if (queued) {
        queued = false;
        debounce = setTimeout(() => void run(true), 300);
      } else schedulePoll();
    };
    const requestRefresh = () => {
      dirty = true;
      clearTimeout(debounce);
      if (visible()) debounce = setTimeout(() => void run(true), 300);
    };
    const focus = () => {
      if (visible() && (dirty || Date.now() - lastSuccess >= 60_000))
        requestRefresh();
    };
    const visibility = () => {
      if (!visible()) {
        clearTimeout(poll);
        clearTimeout(debounce);
      } else {
        focus();
        schedulePoll();
      }
    };
    const unsubscribe = api?.subscribe((change) => {
      if (change.type === "ask_questions_changed") requestRefresh();
    });
    refresh.current = () => void run(true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    void run(false);
    return () => {
      active = false;
      clearTimeout(poll);
      clearTimeout(debounce);
      unsubscribe?.();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
    // Serialized, bounded inputs give each scope/page its own request generation.
  }, [api, key, scope]);

  return {
    ...(view.key === key
      ? view
      : {
          page: null,
          overview: null,
          loading: true,
          error: null,
          overviewError: false,
          accessLost: false
        }),
    refresh: () => refresh.current()
  };
}
