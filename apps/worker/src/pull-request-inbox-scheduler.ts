import { createHash } from "node:crypto";
import type { PullRequestAccount } from "@koed/shared/pull-requests";

export const PULL_REQUEST_INBOX_REFRESH_INTERVAL_MS = 5 * 60_000;

export type PullRequestInboxRefreshTrigger =
  | "startup"
  | "periodic"
  | "wake"
  | "reconnect";

export type PullRequestInboxRefreshRequest = {
  requestId: string;
  account: PullRequestAccount;
  connectionGeneration: number;
};

export function pullRequestInboxAutomaticRequestId(input: {
  account: PullRequestAccount;
  connectionGeneration: number;
  targetDeviceId: string;
  targetDeploymentId: string;
  now?: number;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? PULL_REQUEST_INBOX_REFRESH_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new Error("PullRequestInboxScheduleInvalid");
  if (
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration < 1 ||
    !input.account.id.trim() ||
    !input.account.login.trim() ||
    !input.targetDeviceId.trim() ||
    !input.targetDeploymentId.trim()
  )
    throw new Error("PullRequestInboxScopeInvalid");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("PullRequestInboxScheduleInvalid");
  const cycle = Math.floor(now / intervalMs);
  const scope = JSON.stringify([
    input.targetDeviceId,
    input.targetDeploymentId,
    input.account.id,
    input.account.login.toLocaleLowerCase("en-US"),
    input.connectionGeneration,
    cycle
  ]);
  const digest = createHash("sha256").update(scope).digest("hex");
  return `pr-inbox:auto:${cycle}:${digest}`;
}

export const createPullRequestInboxScheduler = <T>(options: {
  account: () => Promise<{
    account: PullRequestAccount | null;
    connectionGeneration: number;
  }>;
  requestRefresh: (input: PullRequestInboxRefreshRequest) => Promise<T>;
  targetDeviceId: string;
  targetDeploymentId: string;
  onError?: (error: unknown, trigger: PullRequestInboxRefreshTrigger) => void;
  now?: () => number;
  intervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}) => {
  const intervalMs =
    options.intervalMs ?? PULL_REQUEST_INBOX_REFRESH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;
  let lastRequestId: string | null = null;
  let lastRequest: Promise<T | null> | null = null;

  const trigger = async (
    trigger: PullRequestInboxRefreshTrigger
  ): Promise<T | null> => {
    if (stopped) return null;
    const selected = await options.account();
    if (!selected.account) {
      lastRequestId = null;
      lastRequest = null;
      return null;
    }
    const requestId = pullRequestInboxAutomaticRequestId({
      account: selected.account,
      connectionGeneration: selected.connectionGeneration,
      targetDeviceId: options.targetDeviceId,
      targetDeploymentId: options.targetDeploymentId,
      now: now(),
      intervalMs
    });
    if (requestId === lastRequestId && lastRequest) return lastRequest;
    lastRequestId = requestId;
    lastRequest = options
      .requestRefresh({
        requestId,
        account: selected.account,
        connectionGeneration: selected.connectionGeneration
      })
      .catch((error) => {
        if (lastRequestId === requestId) {
          lastRequestId = null;
          lastRequest = null;
        }
        options.onError?.(error, trigger);
        throw error;
      });
    return lastRequest;
  };

  const schedule = () => {
    if (stopped) return;
    const current = now();
    const nextBoundary = (Math.floor(current / intervalMs) + 1) * intervalMs;
    timer = setTimer(
      () => {
        timer = null;
        const lateBy = Math.max(0, now() - nextBoundary);
        const reason = lateBy >= intervalMs ? "wake" : "periodic";
        void trigger(reason)
          .catch(() => undefined)
          .finally(schedule);
      },
      Math.max(1, nextBoundary - current)
    );
    timer.unref?.();
  };

  return {
    trigger,
    start() {
      if (started || stopped) return;
      started = true;
      schedule();
      void trigger("startup").catch(() => undefined);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      lastRequestId = null;
      lastRequest = null;
    }
  };
};
