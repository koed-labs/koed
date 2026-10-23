import { useEffect, useRef, useState } from "react";
import {
  canonicalJsonDigest as crossIdentitySyncDigest,
  conversationSharingRuleCreationIntentSchema
} from "@koed/shared/collaboration";
import type {
  ConversationSharingRuleCreationReview,
  OwnedSharingReason,
  SharedMemorySourceRef,
  SharingRuleDelivery
} from "@koed/shared";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { failureMessage } from "./collaboration-primitives.js";

type Client = Pick<
  CollaborationRendererClient,
  | "previewSharedMemoryCandidate"
  | "previewSharedMemory"
  | "reviewConversationRuleCreation"
  | "createConversationRule"
>;

export function SnapshotConversionReview({
  client,
  source,
  reason,
  grantVersion,
  teamId,
  workspaceId,
  disabled,
  onDelivery
}: {
  client: Client;
  source: Extract<SharedMemorySourceRef, { kind: "captured_session" }>;
  reason: OwnedSharingReason;
  grantVersion: number;
  teamId: string;
  workspaceId: string;
  disabled: boolean;
  onDelivery(delivery: SharingRuleDelivery): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] =
    useState<ConversationSharingRuleCreationReview | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setBusy(false);
    setError("");
    setReview(null);
    return () => {
      epoch.current++;
    };
  }, [
    source.sessionId,
    source.logicalMemoryId,
    reason.id,
    reason.consentId,
    reason.consentVersion,
    grantVersion,
    teamId,
    workspaceId
  ]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => {
        setReview(null);
        setError("This conversion review expired. Review the snapshot again.");
      },
      Math.max(0, Date.parse(review.reviewExpiresAt) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [review]);
  const load = async () => {
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const candidate = await client.previewSharedMemoryCandidate({
        source,
        activationRepresentation: reason.maximumFidelity,
        mode: "continuous"
      });
      if (current !== epoch.current) return;
      if (
        crossIdentitySyncDigest(candidate.source) !==
          crossIdentitySyncDigest(source) ||
        candidate.logicalMemoryId !== source.logicalMemoryId ||
        candidate.items.length === 0
      )
        throw new Error("The selected Conversation is unavailable");
      const preview = await client.previewSharedMemory({
        source,
        sourceCapabilities: candidate.sourceCapabilities,
        logicalMemoryId: source.logicalMemoryId,
        teamId,
        workspaceId,
        activationRepresentation: reason.maximumFidelity,
        maximumFidelity: reason.maximumFidelity,
        includeCuratedMemory: reason.includeCuratedMemory,
        mode: "continuous",
        candidate: {
          source,
          sourceCapabilities: candidate.sourceCapabilities,
          activationRepresentation: candidate.activationRepresentation,
          candidateHash: candidate.candidateHash,
          sourceRevision: candidate.sourceRevision,
          itemCount: candidate.itemCount,
          excludedItemCount: candidate.excludedItemCount,
          manifest: candidate.manifest,
          byteCount: candidate.byteCount,
          mode: "continuous",
          expiresAt: reason.expiresAt
        }
      });
      if (current !== epoch.current) return;
      const next = await client.reviewConversationRuleCreation({
        snapshotReasonId: reason.id,
        previewHash: preview.previewHash,
        previewRevision: preview.previewRevision,
        logicalMemoryId: source.logicalMemoryId,
        teamId,
        workspaceId
      });
      if (current !== epoch.current) return;
      if (
        next.snapshotConversion?.reasonId !== reason.id ||
        next.snapshotConversion.consentId !== reason.consentId ||
        next.snapshotConversion.consentVersion !== reason.consentVersion ||
        next.expectedGrantVersion !== grantVersion ||
        crossIdentitySyncDigest(next.source) !== crossIdentitySyncDigest(source)
      )
        throw new Error("Snapshot authority changed");
      setReview(next);
    } catch (cause) {
      if (current === epoch.current)
        setError(
          failureMessage(
            cause,
            "Conversion could not be reviewed. Refresh sharing and review the current snapshot again."
          )
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (
      !review?.snapshotConversion ||
      Date.parse(review.reviewExpiresAt) <= Date.now()
    )
      return;
    const current = epoch.current;
    setBusy(true);
    setError("");
    try {
      const scope = conversationSharingRuleCreationIntentSchema.strip().parse({
        ...review,
        mutationId: crypto.randomUUID(),
        ruleId: crypto.randomUUID(),
        consentId: crypto.randomUUID(),
        mode: "continuous"
      });
      const { teamWorkspaceId, ...intent } = scope;
      const delivery = await client.createConversationRule({
        ...intent,
        workspaceId: teamWorkspaceId
      });
      if (current !== epoch.current) return;
      onDelivery(delivery);
      setReview(null);
    } catch (cause) {
      if (current === epoch.current) {
        setReview(null);
        setError(
          failureMessage(
            cause,
            "Conversion was not confirmed. Refresh sharing and review the snapshot again."
          )
        );
      }
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Convert snapshot to continuous sharing">
      {review?.snapshotConversion ? (
        <>
          <h4>Convert this snapshot to continuous sharing?</h4>
          <p>
            {review.sourceTitle} · {review.teamName} · {review.workspaceName}
          </p>
          <p>
            Fixed snapshot revision {review.snapshotConversion.sourceRevision}.
            The same detail limit applies to existing and future eligible Memory
            from this Conversation only.
          </p>
          <p>
            The snapshot stays available until continuous publication is ready.
            Other sharing reasons and Conversation Source Access keep their own
            authority.
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void confirm()}
          >
            Review snapshot conversion
          </button>
          <button type="button" disabled={busy} onClick={() => setReview(null)}>
            Cancel conversion
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void load()}
        >
          {busy
            ? "Preparing conversion…"
            : "Convert snapshot to continuous sharing"}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
