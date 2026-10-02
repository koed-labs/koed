"use client";

import { useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CircleHelp,
  FileDiff,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import {
  canConfirmPullRequestPush,
  pullRequestPushConfirmationKey
} from "./PullRequestPushPanel.helpers";
import type { PullRequestActionGrantStatus } from "@/lib/pull-requests-client";

export type PullRequestPushProposal = {
  id: string;
  headRepository: { fullName: string };
  headBranch: string;
  remoteSha: string;
  checkoutHead: string;
  treeSha: string;
  diff: string;
  diffDigest: string;
  commitSha: string;
};

export type PullRequestPushPanelProps = {
  proposal: PullRequestPushProposal | null;
  busy: boolean;
  pendingOperationId: string | null;
  onCheckPending?: () => Promise<void>;
  onCancelPending?: () => Promise<void>;
  uncertainOperationId: string | null;
  error: string | null;
  onPrepare: () => Promise<void>;
  onPush: (proposalId: string, diffDigest: string) => Promise<void>;
  onReconcile: () => Promise<void>;
  actionGrant?: PullRequestActionGrantStatus | null;
  onApproveActionGrant?: () => Promise<void>;
  onCheckActionGrant?: () => Promise<void>;
};

const buttonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function PullRequestPushPanel({
  proposal,
  busy,
  pendingOperationId,
  onCheckPending,
  onCancelPending,
  uncertainOperationId,
  error,
  onPrepare,
  onPush,
  onReconcile,
  actionGrant = null,
  onApproveActionGrant,
  onCheckActionGrant
}: PullRequestPushPanelProps) {
  const [confirmation, setConfirmation] = useState<{
    key: string;
    checked: boolean;
  } | null>(null);
  const currentKey = pullRequestPushConfirmationKey(proposal);
  const confirmed =
    currentKey !== null &&
    confirmation?.key === currentKey &&
    confirmation.checked;
  const canPush = canConfirmPullRequestPush({
    proposal,
    confirmed,
    busy,
    pendingOperationId,
    uncertainOperationId
  });

  const invoke = (action: () => Promise<void>) => {
    // The parent owns API errors and reports them through the `error` prop.
    void action().catch(() => undefined);
  };

  return (
    <section
      className="mt-6 border-t border-border/60 pt-6"
      aria-labelledby="pr-push-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="pr-push-heading"
            className="flex items-center gap-2 font-medium text-foreground-secondary"
          >
            <ArrowUpRight className="h-4 w-4 text-subtle" />
            Propose fixes
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-subtle">
            Inspect the exact branch update before confirming. Koed will push
            only this prepared proposal and will not merge the pull request.
          </p>
        </div>
        {proposal ? (
          <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted">
            Proposal ready
          </span>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {uncertainOperationId ? (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <div className="flex items-start gap-2 text-warning">
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-medium">
                Push outcome needs checking
              </h3>
              <p className="mt-1 text-xs leading-relaxed">
                The push result could not be confirmed. Do not retry it. Check
                the remote state with a read-only request before preparing
                another proposal.
              </p>
              <p className="mt-2 break-all font-mono text-[11px] text-warning/80">
                Operation {uncertainOperationId}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => invoke(onReconcile)}
            className={`${buttonClass} mt-3 border-warning/40 text-warning hover:bg-warning/10`}
          >
            {busy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check remote outcome (read only)
          </button>
        </div>
      ) : pendingOperationId ? (
        <div
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3"
          role="status"
        >
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted">
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
            <span>Push operation is pending.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-[11px] text-subtle">
              {pendingOperationId}
            </span>
            {onCheckPending ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => invoke(onCheckPending)}
                className="rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
              >
                Check operation
              </button>
            ) : null}
            {onCancelPending ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => invoke(onCancelPending)}
                className="rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
              >
                Cancel while queued
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {proposal ? (
        <div className="mt-4 space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border bg-surface/40 p-4 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Destination branch
              </p>
              <p className="mt-1 flex min-w-0 items-center gap-1.5 break-all font-mono text-xs text-foreground-secondary">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span>{proposal.headRepository.fullName}</span>
                <span className="text-faint">/</span>
                <span>{proposal.headBranch}</span>
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Current remote head
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">
                {proposal.remoteSha}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Prepared checkout head
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">
                {proposal.checkoutHead}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Proposed commit
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">
                {proposal.commitSha}
              </p>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Proposed tree
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">
                {proposal.treeSha}
              </p>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Diff digest
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">
                {proposal.diffDigest}
              </p>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/50 px-3 py-2">
              <h3 className="flex items-center gap-2 text-xs font-medium text-foreground-secondary">
                <FileDiff className="h-3.5 w-3.5 text-subtle" />
                Exact proposed diff
              </h3>
              <span className="text-[11px] text-subtle">
                {proposal.diff.length.toLocaleString()} characters
              </span>
            </div>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre bg-background p-3 font-mono text-[11px] leading-relaxed text-muted">
              <code>{proposal.diff || "No diff in this proposal."}</code>
            </pre>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-surface/30 p-3 text-xs leading-relaxed text-muted has-[:disabled]:cursor-not-allowed">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={
                busy || Boolean(pendingOperationId || uncertainOperationId)
              }
              onChange={(event) => {
                if (currentKey)
                  setConfirmation({
                    key: currentKey,
                    checked: event.currentTarget.checked
                  });
              }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>
              I checked this exact diff, destination branch, current remote
              head, and proposed commit. I confirm pushing this proposal.
            </span>
          </label>

          {actionGrant?.review && actionGrant.state === "review_required" ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-sm font-medium text-foreground-secondary">
                {actionGrant.review.title}
              </p>
              <p className="mt-1 text-xs text-muted">
                {actionGrant.review.description}
              </p>
              <p className="mt-2 text-xs text-warning">
                {actionGrant.review.consequence}
              </p>
              {actionGrant.review.details.map((detail, index) => (
                <p
                  key={`${detail.label}-${index}`}
                  className="mt-1 break-words text-xs text-subtle"
                >
                  <span className="font-medium">{detail.label}:</span>{" "}
                  {detail.value}
                </p>
              ))}
              {onApproveActionGrant && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => invoke(onApproveActionGrant)}
                  className={`${buttonClass} mt-3 border-warning/40 text-warning hover:bg-warning/10`}
                >
                  {actionGrant.review.confirmLabel || "Approve exact push"}
                </button>
              )}
            </div>
          ) : null}
          {actionGrant?.state === "pending" ? (
            <div className="rounded-lg border border-border p-3 text-xs text-muted">
              <p>
                Complete the GitHub approval step, then check its status here.
              </p>
              {actionGrant.activationUrl && (
                <a
                  href={actionGrant.activationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-accent underline"
                >
                  Open approval step
                </a>
              )}
              {onCheckActionGrant && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => invoke(onCheckActionGrant)}
                  className="ml-3 rounded border border-border px-2.5 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
                >
                  Check approval
                </button>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex min-w-0 items-start gap-2 text-[11px] leading-relaxed text-subtle">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The confirmation is tied to this proposal ID and diff digest.
              Preparing a changed proposal clears it.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  busy || Boolean(pendingOperationId || uncertainOperationId)
                }
                onClick={() => {
                  setConfirmation(null);
                  invoke(onPrepare);
                }}
                className={`${buttonClass} border-border text-muted hover:bg-surface-hover`}
              >
                {busy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Prepare again
              </button>
              <button
                type="button"
                disabled={
                  !canPush ||
                  actionGrant?.state === "pending" ||
                  actionGrant?.state === "review_required"
                }
                onClick={() => {
                  if (proposal && canPush)
                    invoke(() => onPush(proposal.id, proposal.diffDigest));
                }}
                className={`${buttonClass} border-accent/40 bg-accent/10 text-accent hover:bg-accent/20`}
              >
                {busy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Push confirmed proposal
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-4">
          <p className="text-xs leading-relaxed text-subtle">
            Prepare a bounded proposal from the managed fix checkout. You will
            see the complete diff and verified destination before any push.
          </p>
          <button
            type="button"
            disabled={
              busy || Boolean(pendingOperationId || uncertainOperationId)
            }
            onClick={() => invoke(onPrepare)}
            className={`${buttonClass} border-border text-foreground-secondary hover:bg-surface-hover`}
          >
            {busy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDiff className="h-3.5 w-3.5" />
            )}
            Prepare push proposal
          </button>
        </div>
      )}
    </section>
  );
}
