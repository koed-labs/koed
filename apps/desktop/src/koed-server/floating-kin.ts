import type { RuntimeLifecycleObservation } from "@koed-labs/server";
import {
  fetchBoundedJson,
  floatingKinActivitySchema,
  floatingKinSummarySchema,
  RemoteRequestTimeoutError,
  type AccountState,
  type FloatingKinSummary,
  type FloatingKinSummaryRequest
} from "@koed-labs/shared";
import type { FloatingKinActivityState } from "../ipc/floating-kin-protocol.js";
import { readLocalRuntimeRegistration } from "./local-runtime-registration.js";

// Let the runtime return a typed result before the transport cutoff.
const activityTimeoutMs = 6_000;
const summaryTimeoutMs = 35_000;
const maxResponseBytes = 256 * 1024;

export const createFloatingKinRuntime = ({
  koedHome,
  lifecycle,
  accountStatus
}: {
  koedHome: string;
  lifecycle: () => RuntimeLifecycleObservation["state"];
  accountStatus: () => AccountState["status"];
}) => {
  const state = (): FloatingKinActivityState["state"] => {
    const status = accountStatus();
    if (status === "signed_out" || status === "reauthentication_required")
      return "signed_out";
    const runtime = lifecycle();
    if (runtime !== "running") return runtime;
    if (status === "restoring" || status === "signing_in") return "unavailable";
    // An unconfigured account controller can still have local Personal Memory.
    return "running";
  };

  const request = (
    route: "activity" | "summary",
    body?: FloatingKinSummaryRequest,
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
        timeoutMs: body ? summaryTimeoutMs : activityTimeoutMs,
        maxBytes: maxResponseBytes
      }
    );
  };

  return {
    async activity(signal?: AbortSignal): Promise<FloatingKinActivityState> {
      try {
        const before = state();
        if (before !== "running") return { state: before };
        const { response, payload } = await request(
          "activity",
          undefined,
          signal
        );
        signal?.throwIfAborted();
        const after = state();
        if (after !== "running") return { state: after };
        if (response.ok)
          return {
            state: "running",
            ...floatingKinActivitySchema.parse(payload)
          };
      } catch {
        // Missing registration, bad payload or transport failure fail closed.
      }
      return { state: "unavailable" };
    },
    async summarize(
      input: FloatingKinSummaryRequest,
      signal: AbortSignal
    ): Promise<FloatingKinSummary> {
      try {
        signal.throwIfAborted();
        if (state() !== "running") return { status: "unavailable" };
        const { response, payload } = await request("summary", input, signal);
        signal.throwIfAborted();
        if (response.ok && state() === "running")
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
