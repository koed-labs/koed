import type {
  SourceControlOperation,
  SourceControlCheck,
  SourceControlBranch,
  SourceControlComment,
  SourceControlRemote,
  SourceControlReviewRequest
} from "@koed/shared";
import { GitBranch, LoaderCircle, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";

type UnboundOperation<T = SourceControlOperation> =
  T extends SourceControlOperation
    ? Omit<T, "contractVersion" | "executionId" | "executionGeneration">
    : never;
const commandRequest = (executionId: string) => ({
  requestId: crypto.randomUUID(),
  executionId
});

export function ManagedSourceControlPane({
  api,
  identity,
  revision
}: {
  api: ManagedProjectDesktopApi;
  identity: { executionId: string; executionGeneration: number };
  revision: number;
}) {
  const [error, setError] = useState("");
  const [sourceRemotes, setSourceRemotes] = useState<SourceControlRemote[]>([]);
  const [sourceRemote, setSourceRemote] = useState<SourceControlRemote | null>(
    null
  );
  const [sourceHead, setSourceHead] = useState("");
  const [sourceDefaultBranch, setSourceDefaultBranch] = useState("");
  const [sourceDefaultObjectId, setSourceDefaultObjectId] = useState("");
  const [sourceCurrentBranch, setSourceCurrentBranch] = useState("");
  const [sourceBranches, setSourceBranches] = useState<SourceControlBranch[]>(
    []
  );
  const [reviewRequests, setReviewRequests] = useState<
    SourceControlReviewRequest[]
  >([]);
  const [activeReview, setActiveReview] =
    useState<SourceControlReviewRequest | null>(null);
  const [sourceChecks, setSourceChecks] = useState<SourceControlCheck[]>([]);
  const [sourceComments, setSourceComments] = useState<SourceControlComment[]>(
    []
  );
  const [branchCursor, setBranchCursor] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const [commentCursor, setCommentCursor] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceComment, setSourceComment] = useState("");
  const [sourceReviewTitle, setSourceReviewTitle] = useState("");
  const sourceControl = useCallback(
    async (sourceControlOperation: UnboundOperation) => {
      const result = await api.command({
        ...commandRequest(identity.executionId),
        operation: "source_control",
        sourceControlOperation: {
          contractVersion: 1,
          executionId: identity.executionId,
          executionGeneration: identity.executionGeneration,
          ...sourceControlOperation
        }
      });
      if (result.operation !== "source_control") {
        throw new Error("Unexpected source-control response.");
      }
      return result.result;
    },
    [api, identity.executionGeneration, identity.executionId]
  );

  const loadSourceControl = useCallback(async () => {
    setSourceBusy(true);
    try {
      const result = await sourceControl({ kind: "remotes" });
      if (result.kind !== "remotes") return;
      setSourceRemotes(result.remotes);
      setSourceHead(result.headObjectId);
      const selected =
        result.remotes.find(
          (remote) =>
            remote.remoteIdentityHash === sourceRemote?.remoteIdentityHash
        ) ??
        result.remotes.find(
          (remote) => remote.connectionState === "connected"
        ) ??
        result.remotes[0] ??
        null;
      setSourceRemote(selected);
      if (!selected || selected.connectionState !== "connected") {
        setReviewRequests([]);
        setActiveReview(null);
        setSourceDefaultBranch("");
        setSourceDefaultObjectId("");
        setSourceCurrentBranch("");
        setSourceBranches([]);
        return;
      }
      const [inspection, reviews, branches] = await Promise.all([
        selected.capabilities.includes("repository_read")
          ? sourceControl({
              kind: "inspect",
              remoteIdentityHash: selected.remoteIdentityHash
            })
          : null,
        selected.capabilities.includes("review_request_read")
          ? sourceControl({
              kind: "review_requests",
              remoteIdentityHash: selected.remoteIdentityHash,
              state: "open",
              cursor: null
            })
          : null,
        selected.capabilities.includes("branch_read")
          ? sourceControl({
              kind: "branches",
              remoteIdentityHash: selected.remoteIdentityHash,
              cursor: null
            })
          : null
      ]);
      if (inspection?.kind === "inspect") {
        setSourceDefaultBranch(inspection.defaultBranch);
        setSourceDefaultObjectId(inspection.defaultBranchObjectId);
        setSourceCurrentBranch(inspection.currentBranch ?? "");
      }
      setSourceBranches(branches?.kind === "branches" ? branches.branches : []);
      setBranchCursor(
        branches?.kind === "branches" ? branches.nextCursor : null
      );
      setReviewCursor(
        reviews?.kind === "review_requests" ? reviews.nextCursor : null
      );
      const nextReviews =
        reviews?.kind === "review_requests" ? reviews.reviewRequests : [];
      setReviewRequests(nextReviews);
      setActiveReview(
        (current) =>
          nextReviews.find((item) => item.id === current?.id) ??
          nextReviews[0] ??
          null
      );
    } catch {
      setError("Koed could not load source control.");
    } finally {
      setSourceBusy(false);
    }
  }, [sourceControl, sourceRemote?.remoteIdentityHash]);

  const loadReviewDetail = useCallback(
    async (review: SourceControlReviewRequest) => {
      if (!sourceRemote) return;
      setSourceBusy(true);
      try {
        const [checks, comments] = await Promise.all([
          sourceRemote.capabilities.includes("checks_read")
            ? sourceControl({
                kind: "checks",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                objectId: review.headObjectId
              })
            : null,
          sourceRemote.capabilities.includes("comments_read")
            ? sourceControl({
                kind: "comments",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                number: review.number,
                cursor: null
              })
            : null
        ]);
        setSourceChecks(checks?.kind === "checks" ? checks.checks : []);
        setCommentCursor(
          comments?.kind === "comments" ? comments.nextCursor : null
        );
        setSourceComments(
          comments?.kind === "comments" ? comments.comments : []
        );
      } catch {
        setError("Koed could not load this review request.");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceControl, sourceRemote]
  );

  const loadMore = async (kind: "review_requests" | "comments") => {
    if (!sourceRemote || sourceBusy) return;
    setSourceBusy(true);
    try {
      if (kind === "review_requests" && reviewCursor) {
        const page = await sourceControl({
          kind,
          remoteIdentityHash: sourceRemote.remoteIdentityHash,
          state: "open",
          cursor: reviewCursor
        });
        if (page.kind !== kind) throw new Error("Unexpected review page");
        setReviewRequests((current) => [
          ...current,
          ...page.reviewRequests.filter(
            (item) => !current.some((existing) => existing.id === item.id)
          )
        ]);
        setReviewCursor(page.nextCursor);
      } else if (kind === "comments" && commentCursor && activeReview) {
        const page = await sourceControl({
          kind,
          remoteIdentityHash: sourceRemote.remoteIdentityHash,
          number: activeReview.number,
          cursor: commentCursor
        });
        if (page.kind !== kind) throw new Error("Unexpected comment page");
        setSourceComments((current) => [
          ...current,
          ...page.comments.filter(
            (item) => !current.some((existing) => existing.id === item.id)
          )
        ]);
        setCommentCursor(page.nextCursor);
      }
    } catch {
      setError("Koed could not load the next page.");
    } finally {
      setSourceBusy(false);
    }
  };

  const currentRemoteObjectId = async (): Promise<string | null> => {
    if (!sourceRemote?.capabilities.includes("branch_read"))
      throw new Error("Branch lookup is unavailable");
    const known = sourceBranches.find(
      (branch) => branch.name === sourceCurrentBranch
    );
    if (known) return known.objectId;
    let cursor = branchCursor;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 100)
        throw new Error("Branch lookup did not finish");
      seen.add(cursor);
      const page = await sourceControl({
        kind: "branches",
        remoteIdentityHash: sourceRemote.remoteIdentityHash,
        cursor
      });
      if (page.kind !== "branches") throw new Error("Unexpected branch page");
      const found = page.branches.find(
        (branch) => branch.name === sourceCurrentBranch
      );
      if (found) return found.objectId;
      cursor = page.nextCursor;
    }
    return null;
  };

  useEffect(() => {
    void loadSourceControl();
  }, [loadSourceControl, revision]);

  useEffect(() => {
    if (!activeReview) {
      setSourceChecks([]);
      setSourceComments([]);
      return;
    }
    void loadReviewDetail(activeReview);
  }, [activeReview, loadReviewDetail]);

  return (
    <>
      <div className="personal-source-view">
        <div className="personal-source-toolbar">
          <select
            aria-label="Source-control remote"
            onChange={(event) => {
              const selected =
                sourceRemotes.find(
                  (remote) =>
                    remote.remoteIdentityHash === event.currentTarget.value
                ) ?? null;
              setSourceRemote(selected);
              setReviewRequests([]);
              setActiveReview(null);
            }}
            value={sourceRemote?.remoteIdentityHash ?? ""}
          >
            <option value="">No remote</option>
            {sourceRemotes.map((remote) => (
              <option
                key={remote.remoteIdentityHash}
                value={remote.remoteIdentityHash}
              >
                {remote.remoteName} · {remote.provider.replace("_", " ")}
              </option>
            ))}
          </select>
          <span title={sourceHead}>{sourceHead.slice(0, 8)}</span>
          <button
            aria-label="Fetch remote"
            disabled={
              sourceBusy ||
              sourceRemote?.connectionState !== "connected" ||
              !sourceRemote.credentialGeneration ||
              !sourceRemote.capabilities.includes("fetch")
            }
            onClick={() => {
              if (!sourceRemote?.credentialGeneration) return;
              setSourceBusy(true);
              void sourceControl({
                kind: "fetch",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                remoteName: sourceRemote.remoteName,
                expectedHeadObjectId: sourceHead,
                credentialGeneration: sourceRemote.credentialGeneration,
                idempotencyKey: `desktop-source-fetch:${crypto.randomUUID()}`
              })
                .then(() => loadSourceControl())
                .catch(() =>
                  setError("Koed could not fetch the selected remote.")
                )
                .finally(() => setSourceBusy(false));
            }}
            title="Fetch remote"
            type="button"
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            aria-label="Fast-forward current branch"
            disabled={
              sourceBusy ||
              !sourceRemote?.credentialGeneration ||
              !sourceRemote.capabilities.includes("fetch") ||
              !sourceDefaultBranch ||
              !sourceDefaultObjectId ||
              sourceDefaultObjectId === sourceHead
            }
            onClick={() => {
              if (
                !sourceRemote?.credentialGeneration ||
                !sourceDefaultBranch ||
                !sourceDefaultObjectId
              )
                return;
              setSourceBusy(true);
              void sourceControl({
                kind: "fast_forward",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                remoteName: sourceRemote.remoteName,
                remoteBranch: sourceDefaultBranch,
                expectedRemoteObjectId: sourceDefaultObjectId,
                expectedHeadObjectId: sourceHead,
                credentialGeneration: sourceRemote.credentialGeneration,
                idempotencyKey: `desktop-source-fast-forward:${crypto.randomUUID()}`
              })
                .then(() => loadSourceControl())
                .catch(() =>
                  setError("Koed could not fast-forward this branch.")
                )
                .finally(() => setSourceBusy(false));
            }}
            title="Fast-forward from default branch"
            type="button"
          >
            <GitBranch aria-hidden="true" />
          </button>
          <button
            aria-label="Push current branch"
            disabled={
              sourceBusy ||
              !sourceRemote?.credentialGeneration ||
              !sourceRemote.capabilities.includes("push") ||
              !sourceCurrentBranch
            }
            onClick={() => {
              if (!sourceRemote?.credentialGeneration || !sourceCurrentBranch)
                return;
              const credentialGeneration = sourceRemote.credentialGeneration;
              setSourceBusy(true);
              void currentRemoteObjectId()
                .then((expectedRemoteObjectId) =>
                  sourceControl({
                    kind: "push",
                    remoteIdentityHash: sourceRemote.remoteIdentityHash,
                    remoteName: sourceRemote.remoteName,
                    targetBranch: sourceCurrentBranch,
                    expectedRemoteObjectId,
                    expectedHeadObjectId: sourceHead,
                    credentialGeneration,
                    idempotencyKey: `desktop-source-push:${crypto.randomUUID()}`
                  })
                )
                .then(() => loadSourceControl())
                .catch(() =>
                  setError("Koed could not push the current branch.")
                )
                .finally(() => setSourceBusy(false));
            }}
            title="Push current branch"
            type="button"
          >
            <Upload aria-hidden="true" />
          </button>
        </div>
        {sourceRemote?.connectionState !== "connected" ? (
          <p className="personal-source-empty">
            Connect an account for this repository host to review remote work.
          </p>
        ) : (
          <>
            {sourceRemote.capabilities.includes("review_request_create") &&
            sourceCurrentBranch &&
            sourceDefaultBranch &&
            sourceCurrentBranch !== sourceDefaultBranch ? (
              <form
                className="personal-source-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    !sourceReviewTitle.trim() ||
                    !sourceRemote.credentialGeneration
                  )
                    return;
                  setSourceBusy(true);
                  void sourceControl({
                    kind: "review_request_create",
                    remoteIdentityHash: sourceRemote.remoteIdentityHash,
                    title: sourceReviewTitle.trim(),
                    body: "",
                    sourceBranch: sourceCurrentBranch,
                    targetBranch: sourceDefaultBranch,
                    draft: false,
                    expectedHeadObjectId: sourceHead,
                    credentialGeneration: sourceRemote.credentialGeneration,
                    idempotencyKey: `desktop-source-review-create:${crypto.randomUUID()}`
                  })
                    .then(() => {
                      setSourceReviewTitle("");
                      return loadSourceControl();
                    })
                    .catch(() =>
                      setError("Koed could not create that review request.")
                    )
                    .finally(() => setSourceBusy(false));
                }}
              >
                <input
                  aria-label="Review request title"
                  onChange={(event) =>
                    setSourceReviewTitle(event.currentTarget.value)
                  }
                  placeholder={`Open ${sourceCurrentBranch} into ${sourceDefaultBranch}`}
                  value={sourceReviewTitle}
                />
                <button
                  disabled={sourceBusy || !sourceReviewTitle.trim()}
                  type="submit"
                >
                  Open review request
                </button>
              </form>
            ) : null}
            <div className="personal-source-split">
              <nav aria-label="Open review requests">
                {reviewRequests.length ? (
                  reviewRequests.map((review) => (
                    <button
                      aria-current={
                        review.id === activeReview?.id ? "true" : undefined
                      }
                      key={review.id}
                      onClick={() => setActiveReview(review)}
                      type="button"
                    >
                      <span>#{review.number}</span>
                      {review.title}
                    </button>
                  ))
                ) : (
                  <p>No open review requests.</p>
                )}
                {reviewCursor ? (
                  <button
                    disabled={sourceBusy}
                    onClick={() => void loadMore("review_requests")}
                    type="button"
                  >
                    Load more review requests
                  </button>
                ) : null}
              </nav>
              <section className="personal-source-detail">
                {activeReview ? (
                  <>
                    <header>
                      <strong>{activeReview.title}</strong>
                      <span>
                        {activeReview.sourceBranch} →{" "}
                        {activeReview.targetBranch}
                      </span>
                    </header>
                    <div className="personal-source-checks">
                      {sourceChecks.map((check) => (
                        <span data-state={check.state} key={check.id}>
                          {check.name}: {check.conclusion ?? check.state}
                        </span>
                      ))}
                    </div>
                    <div className="personal-source-comments">
                      {sourceComments.map((comment) => (
                        <article key={comment.id}>
                          <strong>{comment.author}</strong>
                          <p>{comment.body}</p>
                        </article>
                      ))}
                    </div>
                    {commentCursor ? (
                      <button
                        disabled={sourceBusy}
                        onClick={() => void loadMore("comments")}
                        type="button"
                      >
                        Load more comments
                      </button>
                    ) : null}
                    {sourceRemote.capabilities.includes("reviews_write") ? (
                      <div className="personal-source-review-actions">
                        <button
                          disabled={sourceBusy}
                          onClick={() => {
                            if (!sourceRemote.credentialGeneration) return;
                            setSourceBusy(true);
                            void sourceControl({
                              kind: "review_create",
                              remoteIdentityHash:
                                sourceRemote.remoteIdentityHash,
                              number: activeReview.number,
                              decision: "approve",
                              body: "Approved in Koed.",
                              expectedHeadObjectId: activeReview.headObjectId,
                              credentialGeneration:
                                sourceRemote.credentialGeneration,
                              idempotencyKey: `desktop-source-review:${crypto.randomUUID()}`
                            })
                              .catch(() =>
                                setError("Koed could not submit that review.")
                              )
                              .finally(() => setSourceBusy(false));
                          }}
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          disabled={sourceBusy || !sourceComment.trim()}
                          onClick={() => {
                            if (
                              !sourceRemote.credentialGeneration ||
                              !sourceComment.trim()
                            )
                              return;
                            setSourceBusy(true);
                            void sourceControl({
                              kind: "review_create",
                              remoteIdentityHash:
                                sourceRemote.remoteIdentityHash,
                              number: activeReview.number,
                              decision: "request_changes",
                              body: sourceComment.trim(),
                              expectedHeadObjectId: activeReview.headObjectId,
                              credentialGeneration:
                                sourceRemote.credentialGeneration,
                              idempotencyKey: `desktop-source-review:${crypto.randomUUID()}`
                            })
                              .then(() => setSourceComment(""))
                              .catch(() =>
                                setError("Koed could not submit that review.")
                              )
                              .finally(() => setSourceBusy(false));
                          }}
                          type="button"
                        >
                          Request changes
                        </button>
                      </div>
                    ) : null}
                    {sourceRemote.capabilities.includes("comments_write") ? (
                      <form
                        className="personal-source-comment"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (
                            !sourceComment.trim() ||
                            !sourceRemote.credentialGeneration
                          )
                            return;
                          setSourceBusy(true);
                          void sourceControl({
                            kind: "comment_create",
                            remoteIdentityHash: sourceRemote.remoteIdentityHash,
                            number: activeReview.number,
                            body: sourceComment.trim(),
                            expectedHeadObjectId: activeReview.headObjectId,
                            credentialGeneration:
                              sourceRemote.credentialGeneration,
                            idempotencyKey: `desktop-source-comment:${crypto.randomUUID()}`
                          })
                            .then(() => {
                              setSourceComment("");
                              return loadReviewDetail(activeReview);
                            })
                            .catch(() =>
                              setError("Koed could not post that comment.")
                            )
                            .finally(() => setSourceBusy(false));
                        }}
                      >
                        <textarea
                          aria-label="Review comment"
                          onChange={(event) =>
                            setSourceComment(event.currentTarget.value)
                          }
                          placeholder="Add a comment"
                          rows={3}
                          value={sourceComment}
                        />
                        <button
                          disabled={sourceBusy || !sourceComment.trim()}
                          type="submit"
                        >
                          Comment
                        </button>
                      </form>
                    ) : null}
                  </>
                ) : null}
              </section>
            </div>
          </>
        )}
        {sourceBusy ? (
          <LoaderCircle
            aria-label="Loading source control"
            className="personal-cockpit-spin"
          />
        ) : null}
      </div>
      {error ? (
        <p className="personal-cockpit-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
