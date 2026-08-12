import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicDeviceEnrollmentChallenge } from "../local-edge/schemas.js";

import {
  authenticationRequired,
  decideDeviceEnrollmentChallenge,
  loadDeviceEnrollmentChallenge,
  notFound,
  requireBrowserSession
} from "./api.js";
import { AuthPanel } from "./AuthPanel.js";
import { ApprovalShell, Detail, formatDate, Status } from "./layout.js";

type PageState =
  | PublicDeviceEnrollmentChallenge["status"]
  | "loading"
  | "unauthenticated"
  | "unknown"
  | "error";

const operationFamilyLabels: Record<string, string> = {
  admin: "Admin operations",
  action_grant: "Browser-confirmed actions",
  capture_writes: "Capture writes",
  managed_execution: "Managed Conversation execution",
  personal_collaboration_read: "Personal collaboration read access",
  personal_collaboration_write: "Personal collaboration write access",
  personal_memory_read: "Personal Memory recall",
  share_grant_management: "Share Grant management",
  source_download: "Source download",
  sync: "Sync",
  team_chat_read: "Team chat read access",
  team_chat_write: "Team chat write access",
  team_workspace_read: "Team Workspace recall"
};

export const operationFamilyLabel = (family: string): string =>
  operationFamilyLabels[family] ??
  family
    .split(/[_.:-]+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word
    )
    .join(" ");

const metadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export function DeviceEnrollmentApproval({
  challengeId
}: {
  challengeId: string | null;
}) {
  const [challenge, setChallenge] =
    useState<PublicDeviceEnrollmentChallenge | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
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
      if (loaded.status !== "pending") {
        setState(loaded.status);
        return;
      }
      try {
        await requireBrowserSession();
        setState("pending");
      } catch (caught) {
        if (authenticationRequired(caught)) setState("unauthenticated");
        else throw caught;
      }
    } catch (caught) {
      setChallenge(null);
      if (authenticationRequired(caught)) setState("unauthenticated");
      else if (notFound(caught)) setState("unknown");
      else setState("error");
      setError(
        notFound(caught)
          ? "This enrollment request is unknown or no longer available."
          : authenticationRequired(caught)
            ? null
            : "Enrollment lookup failed."
      );
    }
  }, [challengeId]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (["approved", "denied", "expired", "unknown", "error"].includes(state))
      statusRef.current?.focus();
  }, [state]);

  const backendName = useMemo(
    () =>
      challenge
        ? (metadataString(challenge.metadata, "backendDisplayName") ??
          challenge.upstreamBackendId)
        : "Team Backend",
    [challenge]
  );
  const canAct = state === "pending" && !busy;

  const decide = async (decision: "approve" | "deny") => {
    if (!challengeId || !canAct) return;
    setBusy(decision);
    setError(null);
    try {
      const updated = await decideDeviceEnrollmentChallenge(
        challengeId,
        decision
      );
      setChallenge(updated);
      setState(updated.status);
    } catch (caught) {
      if (authenticationRequired(caught)) setState("unauthenticated");
      else {
        setState("error");
        setError(
          "Enrollment decision could not be completed. Check the request status before trying again."
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const terminal = [
    "approved",
    "denied",
    "expired",
    "unknown",
    "error"
  ].includes(state);
  return (
    <ApprovalShell
      description="Review the exact access requested by this local device."
      eyebrow="Local edge enrollment"
      title={`Approve this device for ${backendName}`}
      tone={
        state === "approved"
          ? "success"
          : state === "pending" ||
              state === "loading" ||
              state === "unauthenticated"
            ? "waiting"
            : state === "expired"
              ? "warning"
              : "danger"
      }
    >
      <dl className="details">
        <Detail label="Team Backend" value={backendName} />
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
                  .map(operationFamilyLabel)
                  .join(", ")
              : "No operation families requested"
          }
        />
        <Detail
          label="Expires"
          value={challenge ? formatDate(challenge.expiresAt) : "Unknown"}
        />
        {challenge && metadataString(challenge.metadata, "highLevelContext") ? (
          <Detail
            label="Context"
            value={metadataString(challenge.metadata, "highLevelContext")!}
          />
        ) : null}
      </dl>
      <Status
        error={error}
        message={stateMessage(state)}
        statusRef={statusRef}
        terminal={terminal}
      />
      {state === "unauthenticated" ? (
        <AuthPanel onAuthenticated={load} />
      ) : null}
      {state === "pending" ? (
        <div className="actions">
          <button
            className="danger"
            disabled={!canAct}
            onClick={() => void decide("deny")}
          >
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button
            className="primary"
            disabled={!canAct}
            onClick={() => void decide("approve")}
          >
            {busy === "approve" ? "Approving…" : "Approve device"}
          </button>
        </div>
      ) : null}
      {state === "error" || state === "unknown" ? (
        <div className="actions">
          <button className="secondary" onClick={() => void load()}>
            Retry enrollment lookup
          </button>
        </div>
      ) : null}
    </ApprovalShell>
  );
}

const stateMessage = (state: PageState): string => {
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
    default:
      return "Approve only if this is your local MCP Server or Supported Capture Hook device.";
  }
};
