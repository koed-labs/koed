import { useState } from "react";
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
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setReview(null);
      setSelected([]);
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
      setSelected([]);
    });
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
      setSelected(result.review.sessions.map((session) => session.id));
    });
  const finish = (operation: "apply" | "dismiss") =>
    run(async () => {
      if (!review) return;
      const result = await onReview({
        localProjectId,
        reviewId: review.id,
        expectedRevision: review.event.revision,
        ...(operation === "apply"
          ? { operation, sessionIds: selected }
          : { operation })
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
      <button type="button" disabled={busy} onClick={() => void inspect()}>
        Review repository changes
      </button>
      {events?.length === 0 ? (
        <p>No pending repository changes for this checkout.</p>
      ) : null}
      {event && events?.length ? (
        <>
          <h3>Review repository assignments</h3>
          <p>
            {event.kind === "capture_conflict"
              ? "Capture observed a different repository anchor."
              : "The repository anchor changed."}{" "}
            Recorded assignments remain as recorded until you apply a reviewed
            set.
          </p>
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
            Include sessions with a manual override
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
            Include unresolved history with recorded checkout provenance
          </label>
          <button type="button" disabled={busy} onClick={() => void preview()}>
            Prepare fixed review
          </button>
        </>
      ) : null}
      {review ? (
        <>
          <p>
            {review.count} sessions in this fixed review · {selected.length}{" "}
            selected. Sessions captured later will not be added.
          </p>
          <ul aria-label="Reviewed sessions">
            {review.sessions.map((session) => (
              <li key={session.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(session.id)}
                    disabled={busy || review.status !== "reviewed"}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, session.id]
                          : old.filter((id) => id !== session.id)
                      )
                    }
                  />
                  {session.name}
                </label>
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
                    Manual override to replace:{" "}
                    {session.assignment.override.anchorDisplay ??
                      session.assignment.override.key ??
                      "Unresolved"}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {review.status === "reviewed" ? (
            <>
              <button
                type="button"
                disabled={busy || !selected.length}
                onClick={() => void finish("apply")}
              >
                Apply to {selected.length} selected sessions
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void finish("dismiss")}
              >
                Dismiss without reassignment
              </button>
            </>
          ) : (
            <p role="status">
              {review.status === "applied"
                ? "The accepted set was reassigned."
                : "Review dismissed. Assignments were unchanged."}
            </p>
          )}
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
