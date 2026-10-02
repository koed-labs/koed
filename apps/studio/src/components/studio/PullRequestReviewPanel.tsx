"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Plus, Trash2 } from "lucide-react";
import type {
  PullRequestFrozenReview,
  PullRequestReviewDraft,
  PullRequestReviewRecord
} from "@koed/shared/pull-requests";
import type { PullRequestActionGrantStatus } from "@/lib/pull-requests-client";
import { pullRequestReviewMatchesLatest } from "./PullRequestReviewPanel.helpers";

type ReviewEvent = NonNullable<PullRequestReviewDraft["event"]>;
type ReviewFinding = PullRequestReviewDraft["findings"][number];

export type PullRequestReviewPanelProps = {
  review: PullRequestReviewRecord;
  draft: PullRequestReviewDraft | null;
  frozenReview: PullRequestFrozenReview | null;
  latestScope: { baseSha: string; headSha: string };
  error?: string | null;
  saving?: boolean;
  freezing?: boolean;
  publishing?: boolean;
  publishedUrl?: string | null;
  onSaveDraft: (value: {
    event: ReviewEvent | null;
    body: string;
    findings: ReviewFinding[];
  }) => Promise<void>;
  onFreeze: () => Promise<void>;
  onPublish: (frozenReviewId: string) => Promise<void>;
  onCheckOutcome?: () => Promise<void>;
  canCheckOutcome?: boolean;
  pendingOperation?: { id: string; state: string } | null;
  onCheckPending?: () => Promise<void>;
  onCancelPending?: () => Promise<void>;
  canApprove?: boolean;
  canPublish?: boolean;
  publishGrant?: PullRequestActionGrantStatus | null;
  onApprovePublishGrant?: () => Promise<void>;
  onCheckPublishGrant?: () => Promise<void>;
  onReviewLatest: () => void;
  onEnableFixes?: (request: string) => Promise<void>;
  enablingFixes?: boolean;
};

const EVENTS: Array<{ value: ReviewEvent; label: string }> = [
  { value: "COMMENT", label: "Comment" },
  { value: "APPROVE", label: "Approve" },
  { value: "REQUEST_CHANGES", label: "Request changes" }
];

const EMPTY_FINDING: ReviewFinding = {
  path: "",
  line: null,
  side: "RIGHT",
  body: ""
};

function shortenedSha(value: string) {
  return value.slice(0, 12);
}

export function PullRequestReviewPanel({
  review,
  draft,
  frozenReview,
  latestScope,
  error = null,
  saving = false,
  freezing = false,
  publishing = false,
  publishedUrl = null,
  onSaveDraft,
  onFreeze,
  onPublish,
  onReviewLatest,
  onEnableFixes,
  enablingFixes = false,
  onCheckOutcome,
  canCheckOutcome = false,
  pendingOperation = null,
  onCheckPending,
  onCancelPending,
  canApprove = true,
  canPublish = true,
  publishGrant = null,
  onApprovePublishGrant,
  onCheckPublishGrant
}: PullRequestReviewPanelProps) {
  const isCurrent = pullRequestReviewMatchesLatest(
    { baseSha: review.expectedBaseSha, headSha: review.expectedHeadSha },
    latestScope
  );
  const frozenBelongsToReview = Boolean(
    frozenReview?.reviewId === review.id &&
    frozenReview.baseSha === review.expectedBaseSha &&
    frozenReview.headSha === review.expectedHeadSha &&
    frozenReview.draftRevision === draft?.revision
  );
  const [editingFrozenDraft, setEditingFrozenDraft] = useState(false);
  const hasUnresolvedPublish = Boolean(pendingOperation || canCheckOutcome);
  const editable =
    isCurrent &&
    review.status !== "published" &&
    !hasUnresolvedPublish &&
    (!frozenBelongsToReview || editingFrozenDraft);
  const [event, setEvent] = useState<ReviewEvent>(draft?.event ?? "COMMENT");
  const [body, setBody] = useState(draft?.body ?? "");
  const [findings, setFindings] = useState<ReviewFinding[]>(
    () => draft?.findings.map((finding) => ({ ...finding })) ?? []
  );
  const [exactContentsConfirmation, setExactContentsConfirmation] = useState<{
    key: string;
    checked: boolean;
  } | null>(null);
  const exactContentsConfirmationKey = frozenReview
    ? [
        frozenReview.id,
        frozenReview.digest,
        frozenReview.draftRevision,
        review.revision,
        review.expectedBaseSha,
        review.expectedHeadSha,
        latestScope.baseSha,
        latestScope.headSha
      ].join(":")
    : "";
  const exactContentsConfirmed = Boolean(
    exactContentsConfirmationKey &&
    exactContentsConfirmation?.key === exactContentsConfirmationKey &&
    exactContentsConfirmation.checked
  );
  const [fixRequest, setFixRequest] = useState("");
  const baseDraftRef = useRef(draft);
  const [remoteDraftConflict, setRemoteDraftConflict] =
    useState<PullRequestReviewDraft | null>(null);
  useEffect(() => {
    const previous = baseDraftRef.current;
    const sameScope = previous?.reviewId === draft?.reviewId;
    const localDirty =
      sameScope &&
      previous !== null &&
      (event !== previous.event ||
        body !== previous.body ||
        JSON.stringify(findings) !== JSON.stringify(previous.findings));
    if (draft?.reviewId !== previous?.reviewId) {
      setEvent(draft?.event ?? "COMMENT");
      setBody(draft?.body ?? "");
      setFindings(draft?.findings.map((finding) => ({ ...finding })) ?? []);
      setRemoteDraftConflict(null);
    } else if (draft?.revision !== previous?.revision) {
      if (localDirty && draft) {
        setRemoteDraftConflict(draft);
      } else {
        setEvent(draft?.event ?? "COMMENT");
        setBody(draft?.body ?? "");
        setFindings(draft?.findings.map((finding) => ({ ...finding })) ?? []);
        setRemoteDraftConflict(null);
      }
    }
    baseDraftRef.current = draft;
    // Draft refreshes are compared with the last server snapshot to preserve unsaved local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.reviewId, draft?.revision]);
  const hasChanges = useMemo(() => {
    if (!draft) return body.trim().length > 0 || findings.length > 0;
    return (
      body !== draft.body ||
      event !== draft.event ||
      JSON.stringify(findings) !== JSON.stringify(draft.findings)
    );
  }, [body, draft, event, findings]);
  const updateFinding = (index: number, update: Partial<ReviewFinding>) => {
    setFindings((current) =>
      current.map((finding, candidate) =>
        candidate === index ? { ...finding, ...update } : finding
      )
    );
  };

  return (
    <section
      className="border-t border-border/60 pt-6"
      aria-labelledby="pr-review-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="pr-review-heading"
            className="font-medium text-foreground-secondary"
          >
            Agent review
          </h2>
          <p className="mt-1 text-xs text-subtle">
            Review #{review.id.slice(0, 8)} · revision {review.revision} · head{" "}
            {shortenedSha(review.expectedHeadSha)}
          </p>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium capitalize text-muted">
          {isCurrent ? review.status : "stale"}
        </span>
      </div>

      {!isCurrent && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              The pull request changed after this review began. Review the
              latest version before publishing.
            </p>
          </div>
          <button
            type="button"
            onClick={onReviewLatest}
            className="shrink-0 rounded-md border border-warning/30 px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/10"
          >
            Review latest changes
          </button>
        </div>
      )}
      {!canPublish && isCurrent && (
        <p className="mt-3 rounded-md border border-border bg-surface/50 p-3 text-xs text-subtle">
          This pull request is closed or merged. Review publication and branch
          updates are unavailable.
        </p>
      )}

      {review.workMode === "review" && onEnableFixes && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-4">
          <h3 className="text-sm font-medium text-foreground-secondary">
            Request fixes
          </h3>
          <p className="mt-1 text-xs text-subtle">
            Review Jobs are read-only. Write the fix request you want the Agent
            to carry out. This enables the selected runner permission for the
            existing Job.
          </p>
          <textarea
            value={fixRequest}
            onChange={(change) => setFixRequest(change.currentTarget.value)}
            rows={3}
            maxLength={8_000}
            placeholder="Describe the exact fixes you want…"
            className="mt-3 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint"
          />
          <button
            type="button"
            disabled={!isCurrent || !fixRequest.trim() || enablingFixes}
            onClick={() => void onEnableFixes(fixRequest.trim())}
            className="mt-3 rounded-md border border-warning/40 px-3 py-2 text-xs font-medium text-warning hover:bg-warning/10 disabled:opacity-50"
          >
            {enablingFixes ? (
              <LoaderCircle className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
            ) : null}
            Allow fixes and send request
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {draft && (!frozenBelongsToReview || editingFrozenDraft) ? (
        <div className="mt-4 space-y-4">
          {remoteDraftConflict && (
            <div
              role="status"
              className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted"
            >
              <p>
                A newer saved draft arrived while you had unsaved edits. Reload
                it or keep editing against the newer revision.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEvent(remoteDraftConflict.event ?? "COMMENT");
                    setBody(remoteDraftConflict.body);
                    setFindings(
                      remoteDraftConflict.findings.map((finding) => ({
                        ...finding
                      }))
                    );
                    setRemoteDraftConflict(null);
                  }}
                  className="rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover"
                >
                  Reload saved
                </button>
                <button
                  type="button"
                  onClick={() => setRemoteDraftConflict(null)}
                  className="rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover"
                >
                  Keep edits
                </button>
              </div>
            </div>
          )}
          <label className="block text-xs font-medium text-muted">
            Review action
            <select
              value={event}
              disabled={!editable || saving || freezing || publishing}
              onChange={(change) =>
                setEvent(change.currentTarget.value as ReviewEvent)
              }
              className="mt-1.5 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60"
            >
              {EVENTS.filter(
                (item) => item.value !== "APPROVE" || (canApprove && canPublish)
              ).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-medium text-muted">
            Review summary
            <textarea
              value={body}
              disabled={!editable || saving || freezing || publishing}
              onChange={(change) => setBody(change.currentTarget.value)}
              rows={4}
              maxLength={65_536}
              placeholder="Summarize the review for the pull request…"
              className="mt-1.5 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint disabled:opacity-60"
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground-secondary">
                  Inline comments
                </h3>
                <p className="text-xs text-subtle">
                  Each comment is attached to a file and changed line.
                </p>
              </div>
              <button
                type="button"
                disabled={!editable || saving || freezing || publishing}
                onClick={() =>
                  setFindings((current) => [...current, { ...EMPTY_FINDING }])
                }
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add comment
              </button>
            </div>
            {findings.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-subtle">
                No inline comments in this draft.
              </p>
            ) : (
              <div className="space-y-3">
                {findings.map((finding, index) => (
                  <article
                    key={`${index}-${finding.path}`}
                    className="rounded-lg border border-border bg-surface/40 p-3"
                  >
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_92px_110px_auto]">
                      <label className="text-[11px] font-medium text-subtle">
                        File path
                        <input
                          value={finding.path}
                          disabled={
                            !editable || saving || freezing || publishing
                          }
                          onChange={(change) =>
                            updateFinding(index, {
                              path: change.currentTarget.value
                            })
                          }
                          placeholder="src/file.ts"
                          className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-60"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-subtle">
                        Line
                        <input
                          type="number"
                          min={1}
                          value={finding.line ?? ""}
                          disabled={
                            !editable || saving || freezing || publishing
                          }
                          onChange={(change) =>
                            updateFinding(index, {
                              line: change.currentTarget.value
                                ? Number(change.currentTarget.value)
                                : null
                            })
                          }
                          placeholder="—"
                          className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-60"
                        />
                      </label>
                      <label className="text-[11px] font-medium text-subtle">
                        Side
                        <select
                          value={finding.side ?? "RIGHT"}
                          disabled={
                            !editable || saving || freezing || publishing
                          }
                          onChange={(change) =>
                            updateFinding(index, {
                              side: change.currentTarget.value as
                                | "LEFT"
                                | "RIGHT"
                            })
                          }
                          className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-60"
                        >
                          <option value="RIGHT">Changed line</option>
                          <option value="LEFT">Deleted line</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        aria-label={`Remove inline comment ${index + 1}`}
                        disabled={!editable || saving || freezing || publishing}
                        onClick={() =>
                          setFindings((current) =>
                            current.filter(
                              (_, candidate) => candidate !== index
                            )
                          )
                        }
                        className="mt-4 rounded p-1.5 text-subtle hover:bg-surface-hover hover:text-danger disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <textarea
                      value={finding.body}
                      disabled={!editable || saving || freezing || publishing}
                      onChange={(change) =>
                        updateFinding(index, {
                          body: change.currentTarget.value
                        })
                      }
                      rows={3}
                      maxLength={20_000}
                      placeholder="Explain the issue and requested change…"
                      className="mt-2 block w-full resize-y rounded border border-border bg-background px-2 py-2 text-sm text-foreground placeholder:text-faint disabled:opacity-60"
                    />
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-xs text-subtle">
              Draft revision {draft.revision} · edits stay private until you
              publish.
            </p>
            <button
              type="button"
              disabled={
                !editable || !hasChanges || saving || freezing || publishing
              }
              onClick={() => void onSaveDraft({ event, body, findings })}
              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <LoaderCircle className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save draft
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm text-muted">
            The Agent has not returned an editable review draft yet.
          </p>
        </div>
      )}

      {frozenReview && frozenBelongsToReview && (
        <div className="mt-5 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-foreground">
                Confirm exact GitHub content
              </h3>
              <p className="mt-1 break-all text-xs text-subtle">
                Frozen review {shortenedSha(frozenReview.id)} · digest{" "}
                {shortenedSha(frozenReview.digest)}
              </p>
              <div className="mt-3 rounded-md border border-border bg-background p-3">
                <p className="text-xs font-semibold text-foreground-secondary">
                  {frozenReview.event.replaceAll("_", " ")}
                </p>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted">
                  {frozenReview.body || "No summary text"}
                </p>
                {frozenReview.findings.map((finding, index) => (
                  <div
                    key={`${finding.path}-${finding.line}-${index}`}
                    className="mt-3 border-l-2 border-accent/50 pl-3"
                  >
                    <p className="text-xs font-medium text-foreground-secondary">
                      {finding.path}
                      {finding.line ? `:${finding.line}` : ""} ·{" "}
                      {finding.side ?? "line"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted">
                      {finding.body}
                    </p>
                  </div>
                ))}
              </div>
              {frozenBelongsToReview &&
                !hasUnresolvedPublish &&
                !publishing && (
                  <button
                    type="button"
                    onClick={() => setEditingFrozenDraft(true)}
                    className="mt-3 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover"
                  >
                    Edit draft
                  </button>
                )}
              {publishedUrl ? (
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-xs font-medium text-accent underline"
                >
                  Published on GitHub
                </a>
              ) : review.status === "published" ? (
                <p className="mt-3 text-xs font-medium text-success">
                  GitHub confirmed this review as published.
                </p>
              ) : (
                <>
                  {(review.status === "uncertain" || canCheckOutcome) &&
                    onCheckOutcome && (
                      <button
                        type="button"
                        disabled={!canCheckOutcome || publishing}
                        onClick={() => void onCheckOutcome()}
                        className="mt-3 rounded-md border border-warning/40 px-3 py-2 text-xs font-medium text-warning hover:bg-warning/10 disabled:opacity-50"
                      >
                        Check publication outcome
                      </button>
                    )}
                  {pendingOperation && (
                    <div
                      role="status"
                      className="mt-3 rounded-md border border-border bg-surface/60 p-3 text-xs text-muted"
                    >
                      <p>
                        Publication operation {pendingOperation.id.slice(0, 8)}{" "}
                        is {pendingOperation.state}. It will not be retried
                        automatically.
                      </p>
                      {onCheckPending && (
                        <button
                          type="button"
                          disabled={publishing}
                          onClick={() => void onCheckPending()}
                          className="mt-2 rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
                        >
                          Check operation
                        </button>
                      )}
                      {pendingOperation.state === "pending" &&
                        onCancelPending && (
                          <button
                            type="button"
                            disabled={publishing}
                            onClick={() => void onCancelPending()}
                            className="ml-2 mt-2 rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
                          >
                            Cancel while queued
                          </button>
                        )}
                    </div>
                  )}
                  {publishGrant?.review &&
                    publishGrant.state === "review_required" && (
                      <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 p-3">
                        <p className="text-sm font-medium text-foreground-secondary">
                          {publishGrant.review.title}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {publishGrant.review.description}
                        </p>
                        <p className="mt-2 text-xs text-warning">
                          {publishGrant.review.consequence}
                        </p>
                        {publishGrant.review.details.map((detail, index) => (
                          <p
                            key={`${detail.label}-${index}`}
                            className="mt-1 break-words text-xs text-subtle"
                          >
                            <span className="font-medium">{detail.label}:</span>{" "}
                            {detail.value}
                          </p>
                        ))}
                        {onApprovePublishGrant && (
                          <button
                            type="button"
                            disabled={publishing}
                            onClick={() => void onApprovePublishGrant()}
                            className="mt-3 rounded-md border border-warning/40 px-3 py-2 text-xs font-semibold text-warning hover:bg-warning/10 disabled:opacity-50"
                          >
                            {publishGrant.review.confirmLabel ||
                              "Approve exact publication"}
                          </button>
                        )}
                      </div>
                    )}
                  {publishGrant?.state === "pending" && (
                    <div className="mt-3 rounded-md border border-border p-3 text-xs text-muted">
                      <p>
                        Complete the GitHub approval step, then check its status
                        here.
                      </p>
                      {publishGrant.activationUrl && (
                        <a
                          href={publishGrant.activationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 inline-block text-accent underline"
                        >
                          Open approval step
                        </a>
                      )}
                      {onCheckPublishGrant && (
                        <button
                          type="button"
                          disabled={publishing}
                          onClick={() => void onCheckPublishGrant()}
                          className="ml-3 rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
                        >
                          Check approval
                        </button>
                      )}
                    </div>
                  )}
                  <label className="mt-3 flex items-start gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={exactContentsConfirmed}
                      disabled={
                        !isCurrent ||
                        hasChanges ||
                        publishing ||
                        hasUnresolvedPublish
                      }
                      onChange={(change) =>
                        setExactContentsConfirmation({
                          key: exactContentsConfirmationKey,
                          checked: change.currentTarget.checked
                        })
                      }
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    I reviewed this exact content and want to publish it to
                    GitHub.
                  </label>
                  <button
                    type="button"
                    disabled={
                      !isCurrent ||
                      !canPublish ||
                      hasChanges ||
                      !exactContentsConfirmed ||
                      publishing ||
                      hasUnresolvedPublish ||
                      publishGrant?.state === "pending" ||
                      publishGrant?.state === "review_required"
                    }
                    onClick={() => void onPublish(frozenReview.id)}
                    className="mt-3 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {publishing ? (
                      <LoaderCircle className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {publishGrant?.state === "approved"
                      ? "Publish exact review"
                      : "Request publishing approval"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {frozenReview &&
        frozenReview.reviewId === review.id &&
        !frozenBelongsToReview && (
          <div className="mt-5 rounded-lg border border-border bg-surface/40 p-4">
            <h3 className="text-sm font-medium text-foreground-secondary">
              Previous frozen review
            </h3>
            <p className="mt-1 text-xs text-subtle">
              This frozen content is from an earlier head or draft revision. It
              remains in history and cannot be published as the current review.
            </p>
            <p className="mt-2 break-all font-mono text-[11px] text-subtle">
              {shortenedSha(frozenReview.headSha)} ·{" "}
              {frozenReview.event.replaceAll("_", " ")} ·{" "}
              {shortenedSha(frozenReview.digest)}
            </p>
          </div>
        )}

      {!frozenBelongsToReview && draft && !hasUnresolvedPublish && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={
              !isCurrent ||
              !canPublish ||
              hasChanges ||
              !draft.event ||
              saving ||
              freezing ||
              publishing
            }
            onClick={() => void onFreeze()}
            className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              !isCurrent
                ? "Refresh and review the latest pull request revision first"
                : undefined
            }
          >
            {freezing ? (
              <LoaderCircle className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
            ) : null}
            Freeze review for confirmation
          </button>
        </div>
      )}
    </section>
  );
}
