import { useEffect, useState } from "react";
import { Button } from "@koed/ui";
import { RefreshCw } from "lucide-react";
import type {
  RepositoryChange,
  RepositoryReview
} from "@koed/shared/repository-review";
import type { RendererPlatform } from "../../services/platform.js";

export function RepositoryReviewPanel({
  localProjectId,
  onReview,
  onChanged
}: {
  localProjectId: string;
  onReview: RendererPlatform["reviewRepository"];
  onChanged?: () => Promise<void>;
}) {
  const [events, setEvents] = useState<RepositoryChange[] | null>(null);
  const [event, setEvent] = useState<RepositoryChange | null>(null);
  const [review, setReview] = useState<RepositoryReview | null>(null);
  const [includeOverrides, setIncludeOverrides] = useState(false);
  const [includeUnresolved, setIncludeUnresolved] = useState(false);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setReview(null);

      setError(
        error instanceof Error
          ? error.message
          : "The review result could not be confirmed. Refresh it before trying again."
      );
    } finally {
      setBusy(false);
    }
  };
  const inspect = () =>
    run(async () => {
      const result = await onReview({ operation: "list", localProjectId });
      const next = result.events ?? [];
      setEvents(next);
      setEvent(next[0] ?? null);
      setReview(null);
    });
  useEffect(() => {
    let active = true;
    void onReview({ operation: "list", localProjectId })
      .then((result) => {
        if (!active) return;
        const next = result.events ?? [];
        setEvents(next);
        setEvent(next[0] ?? null);
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Previous assignments are unavailable."
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [localProjectId, onReview]);
  const preview = () =>
    run(async () => {
      if (!event) return;
      const result = await onReview({
        operation: "preview",
        localProjectId,
        eventId: event.id,
        options: { includeOverrides, includeUnresolved }
      });
      if (!result.review) throw new Error("The fixed review is unavailable.");
      setReview(result.review);
    });
  const dismiss = () =>
    run(async () => {
      if (!review) return;
      const result = await onReview({
        localProjectId,
        reviewId: review.id,
        expectedRevision: review.event.revision,
        operation: "dismiss"
      });
      if (!result.review) throw new Error("The review result is unavailable.");
      setReview(result.review);
      setEvents(null);
      try {
        await onChanged?.();
      } catch {
        setError(
          "The review completed. Refresh Projects to see the current assignments."
        );
      }
    });
  return (
    <section
      aria-label="Repository assignment review"
      className="personal-repository-review"
    >
      <div className="personal-project-sharing-intro">
        <p>Inspect the Conversations recorded before a repository change.</p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh previous assignments"
          title="Refresh previous assignments"
          disabled={busy}
          onClick={() => void inspect()}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      {events === null && busy ? (
        <p role="status">Loading previous assignments…</p>
      ) : null}
      {events?.length === 0 ? (
        <p>No previous assignments need review for this folder.</p>
      ) : null}
      {event && events?.length ? (
        <>
          {events.length > 1 && !review ? (
            <label className="personal-project-field">
              Repository change
              <select
                aria-label="Repository change"
                value={event.id}
                disabled={busy}
                onChange={(e) => {
                  setEvent(
                    events.find((entry) => entry.id === e.target.value) ?? null
                  );
                  setReview(null);
                }}
              >
                {events.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.previousIdentity?.anchorDisplay ?? "Unresolved"} →{" "}
                    {entry.targetIdentity.anchorDisplay ??
                      entry.targetIdentity.key ??
                      "Unresolved"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p>
            {event.kind === "capture_conflict"
              ? "Capture observed a different repository anchor."
              : "The repository anchor changed."}{" "}
            Recorded source context stays unchanged until you explicitly correct
            it.
          </p>
          <details className="personal-project-technical">
            <summary>Repository change details</summary>
            <dl>
              <dt>Checkout</dt>
              <dd>{event.targetIdentity.root}</dd>
              <dt>Previous repository</dt>
              <dd>
                {event.previousIdentity?.anchorDisplay ??
                  event.previousIdentity?.key ??
                  "Unresolved"}
              </dd>
              <dt>Target repository</dt>
              <dd>
                {event.targetIdentity.anchorDisplay ??
                  event.targetIdentity.key ??
                  "Unresolved"}
              </dd>
              <dt>Event revision</dt>
              <dd>{event.revision}</dd>
            </dl>
          </details>
          {!review ? (
            <>
              <details className="personal-project-technical">
                <summary>Include more Conversations</summary>
                <p>A checkout is a local copy of a repository.</p>
                <label>
                  <input
                    type="checkbox"
                    checked={includeOverrides}
                    disabled={busy}
                    onChange={(e) => {
                      setIncludeOverrides(e.target.checked);
                      setReview(null);
                    }}
                  />{" "}
                  Include Conversations you assigned manually
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeUnresolved}
                    disabled={busy}
                    onChange={(e) => {
                      setIncludeUnresolved(e.target.checked);
                      setReview(null);
                    }}
                  />{" "}
                  Include unresolved history recorded from this checkout
                </label>
              </details>
              <div className="personal-project-card-actions">
                <Button disabled={busy} onClick={() => void preview()}>
                  Preview Conversations
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {review ? (
        <>
          <p>
            {review.count} Conversations in this review. New captures do not
            enter this list.
          </p>
          <ul aria-label="Reviewed Conversations">
            {review.sessions.map((session) => (
              <li key={session.id}>
                <p>{session.name}</p>
                <p>
                  Assignment version {session.assignment.version} ·{" "}
                  {session.cwd ?? "No recorded path"}
                </p>
                <p>
                  {session.assignment.automatic?.anchorDisplay ??
                    session.assignment.automatic?.key ??
                    "Unresolved history"}{" "}
                  →{" "}
                  {review.event.targetIdentity.anchorDisplay ??
                    review.event.targetIdentity.key ??
                    "Unresolved"}
                </p>
                {session.assignment.override ? (
                  <p>
                    Current source correction:{" "}
                    {session.assignment.override.anchorDisplay ??
                      session.assignment.override.key ??
                      "Unresolved"}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {review.status === "reviewed" ? (
            <div className="personal-project-card-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void dismiss()}
              >
                Dismiss
              </Button>
            </div>
          ) : (
            <p role="status">
              Review complete. Recorded source context is unchanged by this
              inspection.
            </p>
          )}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
