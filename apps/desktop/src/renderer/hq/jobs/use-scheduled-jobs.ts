import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduledJobsDesktopApi } from "../../../ipc/scheduled-jobs-protocol.js";
import type { z } from "zod";
import {
  scheduledJobSchema,
  scheduledJobRunSchema
} from "@koed/shared/scheduled-job-contract";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
type ScheduledJob = z.infer<typeof scheduledJobSchema>;
type ScheduledJobRun = z.infer<typeof scheduledJobRunSchema>;

export type ScheduledJobInventory = {
  jobs: readonly ScheduledJob[];
  runs: readonly ScheduledJobRun[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  pendingIds: ReadonlySet<string>;
  uncertainIds: ReadonlySet<string>;
  acknowledgeUncertain: (jobId: string) => void;
  refresh: () => Promise<void>;
  pause: (job: ScheduledJob, paused: boolean) => Promise<void>;
  runNow: (job: ScheduledJob) => Promise<void>;
  retry: (job: ScheduledJob, run: ScheduledJobRun) => Promise<void>;
  skip: (job: ScheduledJob, run: ScheduledJobRun) => Promise<void>;
};

export function useScheduledJobs(
  api: ScheduledJobsDesktopApi | null | undefined,
  ownerId: string | null | undefined,
  profileKey: string | null | undefined,
  events?: CollaborationRendererClient | null
): ScheduledJobInventory {
  const [jobs, setJobs] = useState<readonly ScheduledJob[]>([]);
  const [runs, setRuns] = useState<readonly ScheduledJobRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const runRequestIds = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  const epoch = useRef(0);
  const current = useRef({ api, ownerId, profileKey });
  current.current = { api, ownerId, profileKey };
  const identity = `${ownerId ?? ""}\u0000${profileKey ?? ""}`;
  useEffect(() => {
    setUncertain(new Set());
    setPending(new Set());
    inFlight.current.clear();
    runRequestIds.current.clear();
  }, [identity]);
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    if (!api || !ownerId || !profileKey) {
      setJobs([]);
      setRuns([]);
      setLoading(false);
      setTruncated(false);
      setLoadedIdentity("");
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const collected: ScheduledJob[] = [];
      let cursor: string | undefined;
      let next: string | null = null;
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await api.command({
          operation: "list",
          ...(cursor ? { cursor } : {})
        });
        if (page.operation !== "list")
          throw new Error("Scheduled Job list changed.");
        if (page.jobs.some((job) => job.ownerUserId !== ownerId))
          throw new Error("Scheduled Job owner changed.");
        collected.push(...page.jobs);
        next = page.nextCursor;
        if (!next) break;
        cursor = next;
      }
      if (new Set(collected.map((job) => job.id)).size !== collected.length)
        throw new Error("Duplicate Scheduled Jobs.");
      const history: ScheduledJobRun[] = [];
      for (let offset = 0; offset < collected.length; offset += 8) {
        const batch = collected.slice(offset, offset + 8);
        const pages = await Promise.all(
          batch.map(async (job) => {
            const collectedRuns: ScheduledJobRun[] = [];
            let runCursor: string | undefined;
            for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
              const page = await api.command({
                operation: "runs",
                jobId: job.id,
                ...(runCursor ? { cursor: runCursor } : {})
              });
              if (
                page.operation !== "runs" ||
                page.jobId !== job.id ||
                page.runs.some((run) => run.jobId !== job.id)
              )
                throw new Error("Scheduled run binding changed.");
              collectedRuns.push(...page.runs);
              if (!page.nextCursor)
                return { runs: collectedRuns, truncated: false };
              runCursor = page.nextCursor;
            }
            return { runs: collectedRuns, truncated: true };
          })
        );
        for (const page of pages) {
          history.push(...page.runs);
          if (page.truncated) next = next ?? "more-runs";
        }
      }
      if (
        generation !== epoch.current ||
        current.current.api !== api ||
        current.current.ownerId !== ownerId ||
        current.current.profileKey !== profileKey
      )
        return;
      setJobs(collected);
      setRuns(history);
      setTruncated(Boolean(next));
      setError(null);
      setLoadedIdentity(identity);
    } catch {
      if (
        generation !== epoch.current ||
        current.current.api !== api ||
        current.current.ownerId !== ownerId ||
        current.current.profileKey !== profileKey
      )
        return;
      setJobs([]);
      setRuns([]);
      setTruncated(false);
      setError("Scheduled Jobs could not load. Try refreshing.");
    } finally {
      if (
        generation === epoch.current &&
        current.current.api === api &&
        current.current.ownerId === ownerId &&
        current.current.profileKey === profileKey
      )
        setLoading(false);
    }
  }, [api, ownerId, profileKey, identity]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 300_000);
    const unsubscribe = events?.subscribe((snapshot, update) => {
      if (
        snapshot.navigation.personalOwner.id !== ownerId ||
        update.authoritativeRecovery ||
        update.kind === "connection" ||
        update.realtimeUpdate?.type === "scheduled_job_changed"
      )
        void refresh();
    });
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      epoch.current++;
      window.clearInterval(timer);
      unsubscribe?.();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, events, ownerId]);
  const mutate = async (
    job: ScheduledJob,
    command: Parameters<ScheduledJobsDesktopApi["command"]>[0]
  ) => {
    if (
      !api ||
      !ownerId ||
      loadedIdentity !== identity ||
      job.ownerUserId !== ownerId ||
      current.current.api !== api ||
      current.current.ownerId !== ownerId ||
      current.current.profileKey !== profileKey
    ) {
      if (loadedIdentity === identity)
        setError("Scheduled Job owner or profile changed. Refresh first.");
      return;
    }
    const latest = jobs.find((item) => item.id === job.id);
    if (!latest || latest.version !== job.version) {
      setError("Scheduled Job version changed. Refresh first.");
      return;
    }
    if (inFlight.current.has(job.id)) {
      setError("A Scheduled Job action is already in progress.");
      return;
    }
    if (command.operation === "runNow" && uncertain.has(job.id)) {
      setError(
        "Review this Job's run history, then acknowledge the uncertain result before a new Run now."
      );
      return;
    }
    const stillCurrent = () =>
      current.current.api === api &&
      current.current.ownerId === ownerId &&
      current.current.profileKey === profileKey;
    inFlight.current.add(job.id);
    setPending((old) => new Set(old).add(job.id));
    try {
      await api.command(command);
      if (!stillCurrent()) return;
      await refresh();
      if (command.operation === "runNow") runRequestIds.current.delete(job.id);
    } catch (cause) {
      if (!stillCurrent()) return;
      const knownRejection =
        typeof cause === "object" &&
        cause !== null &&
        "retryable" in cause &&
        cause.retryable === false;
      if (command.operation === "runNow" && !knownRejection) {
        setUncertain((old) => new Set(old).add(job.id));
      } else if (command.operation === "runNow")
        runRequestIds.current.delete(job.id);
      await refresh();
      if (stillCurrent())
        setError(
          command.operation === "runNow" && !knownRejection
            ? "Run now may have started. Review this Job's run history before requesting another run."
            : "Scheduled Job action failed. Refresh and try again."
        );
    } finally {
      if (stillCurrent()) {
        inFlight.current.delete(job.id);
        setPending((old) => {
          const next = new Set(old);
          next.delete(job.id);
          return next;
        });
      }
    }
  };
  return {
    jobs: loadedIdentity === identity ? jobs : [],
    runs: loadedIdentity === identity ? runs : [],
    loading: loadedIdentity === identity ? loading : true,
    error: loadedIdentity === identity ? error : null,
    truncated: loadedIdentity === identity ? truncated : false,
    refresh,
    pendingIds: loadedIdentity === identity ? pending : new Set(),
    uncertainIds: loadedIdentity === identity ? uncertain : new Set(),
    acknowledgeUncertain: (jobId) => {
      if (loadedIdentity !== identity || !jobs.some((job) => job.id === jobId))
        return;
      setUncertain((old) => {
        const next = new Set(old);
        next.delete(jobId);
        return next;
      });
      runRequestIds.current.delete(jobId);
      setError(null);
    },
    pause: (job, paused) =>
      mutate(job, {
        operation: "pause",
        jobId: job.id,
        expectedVersion: job.version,
        paused
      }),
    runNow: (job) => {
      let requestId = runRequestIds.current.get(job.id);
      if (!requestId) {
        requestId = crypto.randomUUID();
        runRequestIds.current.set(job.id, requestId);
      }
      return mutate(job, {
        operation: "runNow",
        jobId: job.id,
        expectedVersion: job.version,
        requestId
      });
    },
    retry: (job, run) =>
      mutate(job, {
        operation: "retry",
        jobId: job.id,
        runId: run.id,
        expectedVersion: job.version
      }),
    skip: (job, run) =>
      mutate(job, {
        operation: "skip",
        jobId: job.id,
        runId: run.id,
        expectedVersion: job.version
      })
  };
}
