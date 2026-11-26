import type { RuntimeLifecycleObservation } from "@koed-labs/server";
import {
  fetchBoundedJson,
  floatingKinActivitySchema,
  floatingKinPreviewSchema,
  floatingKinSummaryLatestSchema,
  floatingKinSummaryOpenSchema,
  floatingKinSummarySchema,
  RemoteRequestTimeoutError,
  type FloatingKinPreview,
  type FloatingKinPreviewRequest,
  type FloatingKinSummary,
  type FloatingKinSummaryRequest
} from "@koed-labs/shared";
import type {
  FloatingKinActivityState,
  KinLatestSummary,
  KinReopenedSummary,
  KinSummaryTarget
} from "../ipc/floating-kin-protocol.js";
import { readLocalRuntimeRegistration } from "./local-runtime-registration.js";

// Let the runtime return a typed result before the transport cutoff.
const activityTimeoutMs = 6_000;
const summaryTimeoutMs = 35_000;
const maxResponseBytes = 256 * 1024;
const launchWaitMs = 60_000;
const registrationWaitAfterResumeMs = 12_000;

export function createFloatingKinLaunchState(now = Date.now) {
  let deadline = now() + launchWaitMs;
  return {
    pending: () => now() < deadline,
    settle: (ready: boolean) => {
      deadline = ready
        ? Math.min(deadline, now() + registrationWaitAfterResumeMs)
        : 0;
    }
  };
}

export const createFloatingKinRuntime = ({
  koedHome,
  lifecycle,
  launchPending = () => false,
  accountKey
}: {
  koedHome: string;
  lifecycle: () => RuntimeLifecycleObservation["state"];
  launchPending?: () => boolean;
  // Used only to discard stale responses, never to authorize local reads.
  accountKey: () => string;
}) => {
  let readActivity = false;
  const request = (
    route:
      | "activity"
      | "preview"
      | "summary"
      | "summary/latest"
      | "summary/open",
    body?:
      | FloatingKinPreviewRequest
      | FloatingKinSummaryRequest
      | KinSummaryTarget,
    signal?: AbortSignal
  ) => {
    signal?.throwIfAborted();
    const registration = readLocalRuntimeRegistration(koedHome);
    const fetchLocal: typeof fetch = (url, init) => {
      const combined =
        signal && init?.signal
          ? AbortSignal.any([signal, init.signal])
          : (signal ?? init?.signal);
      return fetch(url, { ...init, signal: combined });
    };
    return fetchBoundedJson(
      fetchLocal,
      new URL(`/v1/desktop/floating-kin/${route}`, registration.url),
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: registration.authorization,
          ...(body ? { "content-type": "application/json" } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      },
      {
        timeoutMs: route === "summary" ? summaryTimeoutMs : activityTimeoutMs,
        maxBytes: maxResponseBytes
      }
    );
  };

  const readContext = async (
    route: "preview" | "summary/latest" | "summary/open",
    target: FloatingKinPreviewRequest | KinSummaryTarget,
    signal: AbortSignal
  ): Promise<unknown> => {
    try {
      if (lifecycle() !== "running") return null;
      const key = accountKey();
      const { response, payload } = await request(route, target, signal);
      signal.throwIfAborted();
      return response.ok && lifecycle() === "running" && accountKey() === key
        ? payload
        : null;
    } catch {
      return null;
    }
  };

  return {
    async preview(
      input: FloatingKinPreviewRequest,
      signal: AbortSignal
    ): Promise<FloatingKinPreview> {
      const result = floatingKinPreviewSchema.safeParse(
        await readContext("preview", input, signal)
      );
      return result.success ? result.data : null;
    },
    async latest(
      target: KinSummaryTarget,
      signal: AbortSignal
    ): Promise<KinLatestSummary> {
      const result = floatingKinSummaryLatestSchema.safeParse(
        await readContext("summary/latest", target, signal)
      );
      return result.success ? result.data : { action: null };
    },
    async reopen(
      target: KinSummaryTarget,
      signal: AbortSignal
    ): Promise<KinReopenedSummary> {
      const result = floatingKinSummaryOpenSchema.safeParse(
        await readContext("summary/open", target, signal)
      );
      return result.success ? result.data : null;
    },
    async activity(signal?: AbortSignal): Promise<FloatingKinActivityState> {
      try {
        const before = lifecycle();
        if (before !== "running") return { state: before };
        const key = accountKey();
        const { response, payload } = await request(
          "activity",
          undefined,
          signal
        );
        signal?.throwIfAborted();
        if (accountKey() !== key) return { state: "unavailable" };
        const after = lifecycle();
        if (after !== "running") return { state: after };
        if (response.ok) {
          const activity = floatingKinActivitySchema.parse(payload);
          readActivity = true;
          return { state: "running", ...activity };
        }
      } catch (error) {
        // Supervisor ownership can precede the AI Runtime's registration.
        if (
          !readActivity &&
          !signal?.aborted &&
          launchPending() &&
          error instanceof Error &&
          (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
        )
          return { state: "starting" };
      }
      return { state: "unavailable" };
    },
    async summarize(
      input: FloatingKinSummaryRequest,
      signal: AbortSignal
    ): Promise<FloatingKinSummary> {
      try {
        signal.throwIfAborted();
        if (lifecycle() !== "running") return { status: "unavailable" };
        const key = accountKey();
        const { response, payload } = await request("summary", input, signal);
        signal.throwIfAborted();
        if (response.ok && lifecycle() === "running" && accountKey() === key)
          return floatingKinSummarySchema.parse(payload);
      } catch (error) {
        if (signal.aborted) return { status: "cancelled" };
        if (error instanceof RemoteRequestTimeoutError)
          return { status: "timed_out" };
      }
      return { status: "unavailable" };
    }
  };
};
