import {
  CheckIcon,
  ClockIcon,
  LogInIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import {
  apiBaseUrl,
  approveDeviceEnrollmentChallenge,
  denyDeviceEnrollmentChallenge,
  loadDeviceEnrollmentChallenge
} from "./api";
import koedMarkUrl from "./assets/koed-mark.svg";
import type { DeviceEnrollmentChallenge } from "./types";

type EnrollmentLoadState =
  | "loading"
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "unauthenticated"
  | "unknown"
  | "error";

const operationFamilyLabels: Record<string, string> = {
  admin: "Admin operations",
  capture_writes: "Capture writes",
  personal_memory_read: "Personal Memory recall",
  share_grant_management: "Share Grant management",
  sync: "Sync",
  team_workspace_read: "Team Workspace recall"
};

const safeMetadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const formatEnrollmentDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
};

const enrollmentStateFromChallenge = (
  challenge: DeviceEnrollmentChallenge
): EnrollmentLoadState => {
  if (challenge.status === "approved") return "approved";
  if (challenge.status === "denied") return "denied";
  if (challenge.status === "expired") return "expired";
  return "pending";
};

function EnrollmentStatusIcon({ state }: { state: EnrollmentLoadState }) {
  if (state === "approved") {
    return <CheckIcon className="size-4 text-success-foreground" />;
  }
  if (state === "denied" || state === "unknown" || state === "error") {
    return <XIcon className="size-4 text-destructive-foreground" />;
  }
  if (state === "expired") {
    return <ClockIcon className="size-4 text-warning-foreground" />;
  }
  if (state === "unauthenticated") {
    return <LogInIcon className="size-4 text-info-foreground" />;
  }
  return <ShieldCheckIcon className="size-4 text-info-foreground" />;
}

export function DeviceEnrollmentApproval({
  challengeId
}: {
  challengeId: string | null;
}) {
  const [challenge, setChallenge] = useState<DeviceEnrollmentChallenge | null>(
    null
  );
  const [state, setState] = useState<EnrollmentLoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  const loadChallenge = useCallback(async () => {
    if (!challengeId) {
      setState("unknown");
      setError("Enrollment challenge is missing.");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const loaded = await loadDeviceEnrollmentChallenge(challengeId);
      setChallenge(loaded);
      setState(enrollmentStateFromChallenge(loaded));
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Enrollment lookup failed.";
      setChallenge(null);
      if (message.toLowerCase().includes("session cookie")) {
        setState("unauthenticated");
      } else if (message.toLowerCase().includes("not found")) {
        setState("unknown");
      } else {
        setState("error");
      }
      setError(message);
    }
  }, [challengeId]);

  useEffect(() => {
    void loadChallenge();
  }, [loadChallenge]);

  const backendDisplayName = useMemo(
    () =>
      challenge
        ? (safeMetadataString(challenge.metadata, "backendDisplayName") ??
          challenge.upstreamBackendId)
        : "Team Backend",
    [challenge]
  );
  const backendProfile = challenge
    ? safeMetadataString(challenge.metadata, "backendProfile")
    : null;
  const highLevelContext = challenge
    ? safeMetadataString(challenge.metadata, "highLevelContext")
    : null;
  const canAct = state === "pending" && !busy;

  const submitDecision = async (decision: "approve" | "deny") => {
    if (!challengeId || !canAct) return;
    setBusy(decision);
    setError(null);
    try {
      const updated =
        decision === "approve"
          ? await approveDeviceEnrollmentChallenge(challengeId)
          : await denyDeviceEnrollmentChallenge(challengeId);
      setChallenge(updated);
      setState(enrollmentStateFromChallenge(updated));
    } catch (caught) {
      setState("error");
      setError(
        caught instanceof Error ? caught.message : "Enrollment update failed."
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <img alt="" className="mt-0.5 size-8" src={koedMarkUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span>Local edge enrollment</span>
              {backendProfile ? <span>{backendProfile}</span> : null}
            </div>
            <h1 className="mt-1 text-balance font-semibold text-2xl tracking-normal">
              Approve this device for {backendDisplayName}
            </h1>
          </div>
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg border",
              state === "approved" && "border-success/30 bg-success/10",
              state === "denied" && "border-destructive/30 bg-destructive/10",
              state === "expired" && "border-warning/30 bg-warning/10",
              (state === "pending" ||
                state === "loading" ||
                state === "unauthenticated") &&
                "border-info/30 bg-info/10"
            )}
          >
            <EnrollmentStatusIcon state={state} />
          </div>
        </div>

        <div className="mt-5 grid gap-3 rounded-lg border border-border bg-secondary/30 p-4 sm:grid-cols-2">
          <Detail label="Team Backend" value={backendDisplayName} />
          <Detail
            label="Local device"
            value={
              challenge?.deviceLabel ?? challenge?.deviceInstanceId ?? "Unknown"
            }
          />
          <Detail
            label="Requested access"
            value={
              challenge?.requestedOperationFamilies.length
                ? challenge.requestedOperationFamilies
                    .map((family) => operationFamilyLabels[family] ?? family)
                    .join(", ")
                : "No operation families requested"
            }
          />
          <Detail
            label="Expires"
            value={
              challenge ? formatEnrollmentDate(challenge.expiresAt) : "Unknown"
            }
          />
          {highLevelContext ? (
            <Detail
              className="sm:col-span-2"
              label="Context"
              value={highLevelContext}
            />
          ) : null}
        </div>

        <div className="mt-5 rounded-lg border border-border p-4">
          <p className="font-medium text-sm">{stateMessage(state)}</p>
          {error ? (
            <p className="mt-1 text-destructive-foreground text-sm">{error}</p>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {state === "unauthenticated" ? (
            <Button
              onClick={() => {
                window.location.href = `${apiBaseUrl}/auth/workos/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`;
              }}
              size="lg"
            >
              <LogInIcon className="size-4" />
              Sign in
            </Button>
          ) : (
            <>
              <Button
                disabled={!canAct}
                onClick={() => void submitDecision("deny")}
                size="lg"
                variant="destructive-outline"
              >
                {busy === "deny" ? (
                  <RefreshCwIcon className="size-4 animate-spin" />
                ) : (
                  <XIcon className="size-4" />
                )}
                Deny
              </Button>
              <Button
                disabled={!canAct}
                onClick={() => void submitDecision("approve")}
                size="lg"
              >
                {busy === "approve" ? (
                  <RefreshCwIcon className="size-4 animate-spin" />
                ) : (
                  <ShieldCheckIcon className="size-4" />
                )}
                Approve device
              </Button>
              {state === "error" || state === "unknown" ? (
                <Button
                  onClick={() => void loadChallenge()}
                  size="lg"
                  variant="outline"
                >
                  <RefreshCwIcon className="size-4" />
                  Retry
                </Button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function Detail({
  className,
  label,
  value
}: {
  className?: string;
  label: string;
  value: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 break-words font-medium text-sm">{value}</div>
    </div>
  );
}

function stateMessage(state: EnrollmentLoadState): string {
  switch (state) {
    case "approved":
      return "This local device is approved. The local edge can finish storing its device credential.";
    case "denied":
      return "This enrollment request was denied. The challenge can no longer be exchanged.";
    case "expired":
      return "This enrollment request expired. Start enrollment again from the local device.";
    case "unauthenticated":
      return "Sign in with a browser session before approving local-edge device enrollment.";
    case "unknown":
      return "This enrollment request was not found, revoked, or already removed.";
    case "error":
      return "Enrollment approval could not be completed.";
    case "loading":
      return "Loading enrollment request.";
    case "pending":
    default:
      return "Approve only if this is your local MCP Server or Supported Capture Hook device.";
  }
}
