import { useEffect, useRef, useState } from "react";
import { canonicalJsonDigest } from "@koed/shared/collaboration";
import type {
  GitAnchorSharingReviewInput,
  SharingRuleDelivery,
  SharingRulePublisherTakeoverLocalReview
} from "@koed/shared";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { failureMessage } from "./collaboration-primitives.js";

type Choice = { sessionId: string; title: string };
export type PublisherReviewClient = Pick<
  CollaborationRendererClient,
  "reviewPublisherTakeover" | "takeOverPublisher"
> &
  Partial<Pick<CollaborationRendererClient, "reviewGitAnchorSharing">>;

/** Personal pointers are chosen locally. The local edge verifies their original
 * identity against the exact existing Team member before native approval. */
export function SharingRulePublisherReview({
  client,
  ruleId,
  teamId,
  workspaceId,
  authorityVersion,
  publisherFence,
  maximumFidelity,
  target,
  sourceChoices = [],
  disabled = false,
  onDelivery
}: {
  client: PublisherReviewClient;
  ruleId: string;
  teamId: string;
  workspaceId: string;
  authorityVersion: number;
  publisherFence: number;
  maximumFidelity: GitAnchorSharingReviewInput["representation"];
  target?: GitAnchorSharingReviewInput["target"];
  sourceChoices?: Choice[];
  disabled?: boolean;
  onDelivery(delivery: SharingRuleDelivery): void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]),
    [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [review, setReview] =
    useState<SharingRulePublisherTakeoverLocalReview | null>(null);
  const epoch = useRef(0),
    snapshot = useRef<string | null>(null);
  const scopeKey = canonicalJsonDigest({
    ruleId,
    teamId,
    workspaceId,
    authorityVersion,
    publisherFence,
    maximumFidelity,
    target
  });
  const choicesKey = canonicalJsonDigest(sourceChoices);
  useEffect(() => {
    epoch.current++;
    setOpen(false);
    setBusy(false);
    setError("");
    setReview(null);
    setCursor(null);
    snapshot.current = null;
    setChoices(sourceChoices);
    setSelected(sourceChoices.length === 1 ? sourceChoices[0]!.sessionId : "");
    return () => {
      epoch.current++;
    };
    // The content keys keep unrelated owner-view refreshes from resetting a review.
  }, [scopeKey, choicesKey, client]);
  const loadSources = async (after: string | null) => {
    if (!target || !client.reviewGitAnchorSharing) return;
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const page = await client.reviewGitAnchorSharing({
        target,
        teamId,
        workspaceId,
        representation: maximumFidelity,
        cursor: after
      });
      if (current !== epoch.current) return;
      if (
        canonicalJsonDigest(page.target) !== canonicalJsonDigest(target) ||
        page.destination.teamId !== teamId ||
        page.destination.workspaceId !== workspaceId ||
        page.destination.representation !== maximumFidelity ||
        (after && page.snapshotVersion !== snapshot.current) ||
        (page.nextCursor && page.nextCursor === after)
      )
        throw new Error(
          "The Personal selection changed. Refresh the Conversations."
        );
      snapshot.current = page.snapshotVersion;
      const next = page.entries
        .filter((entry) => entry.source.identityState === "verified")
        .map((entry) => ({
          sessionId: entry.source.localSessionId,
          title: entry.title
        }));
      const merged = new Map(
        (after ? choices : []).map((choice) => [choice.sessionId, choice])
      );
      for (const choice of next) merged.set(choice.sessionId, choice);
      if (merged.size > 5000)
        throw new Error(
          "Choose a smaller Personal selection to review its publisher."
        );
      const values = [...merged.values()];
      setChoices(values);
      setCursor(page.nextCursor);
      setSelected((previous) =>
        values.some((choice) => choice.sessionId === previous)
          ? previous
          : values.length === 1
            ? values[0]!.sessionId
            : ""
      );
    } catch (cause) {
      if (current === epoch.current)
        setError(
          failureMessage(
            cause,
            "Personal Conversations are unavailable. Refresh and try again."
          )
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const loadReview = async () => {
    if (!selected || busy || disabled) return;
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const next = await client.reviewPublisherTakeover({
        ruleId,
        teamId,
        workspaceId,
        expectedAuthorityVersion: authorityVersion,
        publisherFence,
        localSessionId: selected,
        ...(target ? { target } : {})
      });
      if (current !== epoch.current) return;
      if (
        next.review.ruleId !== ruleId ||
        next.review.teamId !== teamId ||
        next.review.teamWorkspaceId !== workspaceId ||
        next.review.expectedAuthorityVersion !== authorityVersion ||
        next.review.publisherFence !== publisherFence ||
        next.localSource.localSessionId !== selected ||
        next.target?.kind !== target?.kind
      )
        throw new Error(
          "The publisher review changed. Refresh sharing before trying again."
        );
      if (Date.parse(next.review.expiresAt) <= Date.now())
        throw new Error("The publisher review expired. Review it again.");
      setReview(next);
    } catch (cause) {
      if (current === epoch.current)
        setError(
          failureMessage(
            cause,
            "The publisher or source is unavailable. Choose an already shared Conversation available on this device and review again."
          )
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!review || busy || disabled) return;
    if (Date.parse(review.review.expiresAt) <= Date.now()) {
      setReview(null);
      setError("The publisher review expired. Review it again.");
      return;
    }
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const delivery = await client.takeOverPublisher({
        ...review,
        operationKind: "publisher_takeover",
        mutationId: crypto.randomUUID(),
        ruleId,
        teamId,
        workspaceId
      });
      if (current !== epoch.current) return;
      onDelivery(delivery);
      setOpen(false);
      setReview(null);
    } catch (cause) {
      if (current === epoch.current) {
        setReview(null);
        setError(
          failureMessage(
            cause,
            "Publisher transfer was not confirmed. Refresh sharing and review it again."
          )
        );
      }
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          if (target) void loadSources(null);
        }}
      >
        Transfer publisher
      </button>
    );
  return (
    <fieldset
      className="collab-form"
      disabled={disabled || busy}
      aria-label="Transfer rule publisher"
    >
      <legend>Use this device as publisher</legend>
      <p>
        Choose a Conversation already shared by this rule. Its original Personal
        identity will be checked before approval.
      </p>
      {error ? (
        <p role="alert" className="collab-form-error">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status">
          {review
            ? "Waiting for publisher approval…"
            : "Checking publisher availability…"}
        </p>
      ) : null}
      <label>
        Conversation on this device
        <select
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setReview(null);
            setError("");
          }}
        >
          <option value="">Choose a Conversation</option>
          {choices.map((choice) => (
            <option key={choice.sessionId} value={choice.sessionId}>
              {choice.title}
            </option>
          ))}
        </select>
      </label>
      {!busy && !choices.length ? (
        <p>Sync an already shared Conversation to this device, then refresh.</p>
      ) : null}
      {target ? (
        <div>
          <button type="button" onClick={() => void loadSources(null)}>
            Refresh Conversations
          </button>
          {cursor ? (
            <button type="button" onClick={() => void loadSources(cursor)}>
              Load more Conversations
            </button>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <div>
          <p>
            Publisher:{" "}
            {review.review.currentPublisher.label ?? "Unnamed device"} →{" "}
            {review.review.receivingPublisher.label ?? "This device"}.
          </p>
          <p>
            {review.review.state === "paused"
              ? "Updates remain paused."
              : "Updates remain active and catch up after processing."}{" "}
            The approved selection and content limits stay the same.
          </p>
          <p>
            Unavailable sources stay pending. Existing Conversations stay on
            their current devices.
          </p>
          <button type="button" onClick={() => void confirm()}>
            Continue to publisher approval
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!selected || disabled || busy}
          onClick={() => void loadReview()}
        >
          Review publisher transfer
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          epoch.current++;
          setOpen(false);
          setReview(null);
          setError("");
        }}
      >
        Cancel publisher transfer
      </button>
    </fieldset>
  );
}
