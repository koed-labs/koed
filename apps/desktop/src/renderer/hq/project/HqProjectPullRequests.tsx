import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Project,
  SourceControlCheck,
  SourceControlRemote,
  SourceControlReviewRequest
} from "@koed/shared";
import type { WorkItem } from "@koed/shared/work-item-contract";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectNavigation } from "../project-navigation.js";
import { safeWorkItemPrUrl } from "./hq-work-item-model.js";
import "./hq-project-pull-requests.css";

type Row = {
  key: string;
  executionId: string;
  executionGeneration: number;
  remote: SourceControlRemote;
  review: SourceControlReviewRequest;
  checks: SourceControlCheck[];
  item: WorkItem | null;
  proposed: boolean;
  proposalId: string | null;
  capability: {
    available: boolean;
    provider: string | null;
    allowedMergeMethods: Array<"merge" | "squash" | "rebase">;
    openUrl: string | null;
    reviewSummary?: {
      requiredReviewCount: number;
      approvedReviewCount: number;
      headObjectId: string;
      reviews: Array<{
        user: string;
        state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
      }>;
    } | null;
  } | null;
};
const providerLabel = (provider: string) =>
  ({
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure_devops: "Azure DevOps"
  })[provider] ?? provider;

export function HqProjectPullRequests({
  project,
  personalProjects,
  graphProjects,
  workItems,
  api,
  conversations,
  projectsApi,
  onWorkItemsChanged,
  mergeRequestedItemId,
  onMergeRequestHandled,
  onNeedsCount,
  onVisibleCount,
  onCoveredWorkItemIds,
  showEmpty = true,
  ownerId,
  profileKey,
  limit,
  mode = "review"
}: {
  project: Project;
  personalProjects: readonly Project[];
  graphProjects: readonly DesktopProject[];
  workItems: readonly WorkItem[];
  api: ManagedProjectDesktopApi | null;
  conversations: ManagedConversationDesktopApi | null;
  projectsApi: ProjectsDesktopApi;
  onWorkItemsChanged?: () => void;
  mergeRequestedItemId?: string | null;
  onMergeRequestHandled?: () => void;
  onNeedsCount?: (count: number) => void;
  onVisibleCount?: (count: number) => void;
  onCoveredWorkItemIds?: (ids: readonly string[]) => void;
  showEmpty?: boolean;
  ownerId: string | null;
  profileKey: string | null;
  limit?: number;
  mode?: "need" | "review";
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [unknown, setUnknown] = useState<Record<string, string>>({});
  const handledMergeRequest = useRef<string | null>(null);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const mergeInFlight = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshSequence.current += 1;
    };
  }, []);
  const journalKey = (rowKey: string) =>
    `koed-hq-merge-readonly:${ownerId}:${profileKey}:${project.id}:${rowKey}`;
  const command = useCallback(
    async (input: Parameters<ManagedProjectDesktopApi["command"]>[0]) => {
      if (!api) throw new Error("Source control is unavailable");
      return api.command(input);
    },
    [api]
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        setRevision((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!api || !conversations?.list) return;
    let live = true;
    const sequence = ++refreshSequence.current;
    void (async () => {
      try {
        const listed = await conversations.list!();
        const projectThreads =
          projectNavigation(personalProjects, graphProjects).projects.find(
            (entry) => entry.id === project.id
          )?.conversations ?? [];
        const projectExecutions = listed.executions.filter(
          (entry) =>
            entry.projectId === project.id ||
            projectThreads.some(
              (thread) =>
                thread.technicalProjectId === entry.projectId &&
                thread.thread.sessionId === entry.sessionId
            )
        );
        const linkedExecutionIds = new Set(
          workItems
            .filter((item) => item.status === "review")
            .map((item) => item.executionId)
        );
        const executions = projectExecutions.filter(
          (entry, index) =>
            index < 8 || linkedExecutionIds.has(entry.executionId)
        );
        const next: Row[] = [];
        for (const execution of executions) {
          try {
            const runtime = await conversations.runtime(execution.executionId);
            const generation = runtime.executionGeneration;
            const base = {
              requestId: crypto.randomUUID(),
              executionId: execution.executionId
            };
            const source = async (operation: Record<string, unknown>) => {
              const result = await command({
                ...base,
                operation: "source_control",
                sourceControlOperation: {
                  contractVersion: 1,
                  executionId: execution.executionId,
                  executionGeneration: generation,
                  ...operation
                }
              } as Parameters<ManagedProjectDesktopApi["command"]>[0]);
              return result.operation === "source_control"
                ? result.result
                : null;
            };
            const remotes = await source({ kind: "remotes" });
            if (remotes?.kind !== "remotes") continue;
            const proposalNumbers = new Map<number, string>();
            for (const item of runtime.items) {
              const proposal = item.payload.mergeProposal;
              if (
                item.executionGeneration === generation &&
                item.state === "pending" &&
                proposal &&
                typeof proposal === "object" &&
                !Array.isArray(proposal) &&
                Number.isSafeInteger(
                  (proposal as Record<string, unknown>).reviewRequestNumber
                )
              )
                proposalNumbers.set(
                  (proposal as { reviewRequestNumber: number })
                    .reviewRequestNumber,
                  item.id
                );
            }
            for (const remote of remotes.remotes) {
              if (
                remote.connectionState !== "connected" ||
                !remote.capabilities.includes("review_request_read")
              )
                continue;
              const linked = workItems.filter(
                (item) =>
                  item.executionId === execution.executionId &&
                  item.status === "review" &&
                  item.prNumber &&
                  (() => {
                    try {
                      return (
                        new URL(safeWorkItemPrUrl(item) ?? "").hostname ===
                        remote.host
                      );
                    } catch {
                      return false;
                    }
                  })()
              );
              const opened = await source({
                kind: "review_requests",
                remoteIdentityHash: remote.remoteIdentityHash,
                state: "open",
                cursor: null
              });
              const byNumber = new Map<number, SourceControlReviewRequest>();
              if (opened?.kind === "review_requests")
                for (const review of opened.reviewRequests)
                  byNumber.set(review.number, review);
              for (const number of new Set([
                ...linked.map((item) => item.prNumber!),
                ...proposalNumbers.keys()
              ])) {
                if (byNumber.has(number)) continue;
                const result = await source({
                  kind: "review_request",
                  remoteIdentityHash: remote.remoteIdentityHash,
                  number
                }).catch(() => null);
                if (result?.kind === "review_request")
                  byNumber.set(number, result.reviewRequest);
              }
              for (const review of byNumber.values()) {
                const item =
                  linked.find(
                    (candidate) =>
                      candidate.prNumber === review.number &&
                      safeWorkItemPrUrl(candidate) === review.webUrl
                  ) ?? null;
                const checks = remote.capabilities.includes("checks_read")
                  ? await source({
                      kind: "checks",
                      remoteIdentityHash: remote.remoteIdentityHash,
                      objectId: review.headObjectId
                    }).catch(() => null)
                  : null;
                const capabilityResult = await command({
                  ...base,
                  operation: "source_control_merge_capability",
                  executionGeneration: generation,
                  remoteIdentityHash: remote.remoteIdentityHash,
                  reviewRequestNumber: review.number
                }).catch(() => null);
                const capability =
                  capabilityResult?.operation ===
                    "source_control_merge_capability" &&
                  capabilityResult.result.kind ===
                    "review_request_merge_capability"
                    ? capabilityResult.result
                    : null;
                next.push({
                  key: `${execution.executionId}:${remote.remoteIdentityHash}:${review.number}`,
                  executionId: execution.executionId,
                  executionGeneration: generation,
                  remote,
                  review,
                  checks: checks?.kind === "checks" ? checks.checks : [],
                  item,
                  proposed: proposalNumbers.has(review.number),
                  proposalId: proposalNumbers.get(review.number) ?? null,
                  capability
                });
              }
            }
          } catch {
            // One unavailable execution must not hide other Project pull requests.
          }
        }
        const byUrl = new Map<string, Row[]>();
        for (const row of next) {
          const matches = byUrl.get(row.review.webUrl) ?? [];
          matches.push(row);
          byUrl.set(row.review.webUrl, matches);
        }
        const unique = [...byUrl.values()].map((matches) => {
          if (matches.length === 1) return matches[0]!;
          const linked = matches.filter((row) => row.item);
          if (linked.length === 1) return linked[0]!;
          // A duplicate without one exact Work Item owner has no merge authority.
          return { ...matches[0]!, capability: null, proposed: false };
        });
        if (live && sequence === refreshSequence.current && mounted.current) {
          setRows(unique);
          const pending: Record<string, string> = {};
          for (const row of unique) {
            const operationId = window.localStorage.getItem(
              journalKey(row.key)
            );
            if (operationId && /^[a-f0-9-]{36}$/i.test(operationId))
              pending[row.key] = operationId;
          }
          setUnknown(pending);
          const unhandledProposals = unique.filter(
            (row) =>
              row.proposalId &&
              !pending[row.key] &&
              !window.localStorage.getItem(
                `koed-hq-merge-proposal:${ownerId}:${profileKey}:${project.id}:${row.key}:${row.proposalId}`
              )
          );
          const firstProposal =
            unhandledProposals.length === 1 &&
            unhandledProposals[0]?.capability?.available
              ? unhandledProposals[0]
              : null;
          if (unhandledProposals.length > 1)
            setError(
              "Merge proposal matches multiple pull requests. Open the intended pull request and choose Merge there."
            );
          if (
            firstProposal?.proposalId &&
            !mergeRequestedItemId &&
            mode === "need"
          ) {
            window.localStorage.setItem(
              `koed-hq-merge-proposal:${ownerId}:${profileKey}:${project.id}:${firstProposal.key}:${firstProposal.proposalId}`,
              "reviewed"
            );
            void merge(firstProposal);
          }
        }
        if (
          live &&
          sequence === refreshSequence.current &&
          mounted.current &&
          projectsApi.workItemReconcile
        ) {
          const reviewed = workItems.filter(
            (item) => item.status === "review" && item.prNumber
          );
          const updated = await Promise.allSettled(
            reviewed.map((item) =>
              projectsApi.workItemReconcile!(project.id, item.id)
            )
          );
          if (
            live &&
            sequence === refreshSequence.current &&
            mounted.current &&
            updated.some(
              (result, index) =>
                result.status === "fulfilled" &&
                result.value.version !== reviewed[index]!.version
            )
          )
            onWorkItemsChanged?.();
        }
      } catch {
        if (live && sequence === refreshSequence.current && mounted.current)
          setError("Pull requests could not be refreshed.");
      }
    })();
    return () => {
      live = false;
    };
  }, [
    api,
    command,
    conversations,
    project.id,
    personalProjects,
    graphProjects,
    workItems,
    projectsApi,
    onWorkItemsChanged,
    mergeRequestedItemId,
    onMergeRequestHandled,
    ownerId,
    profileKey,
    mode,
    revision
  ]);

  const merge = async (row: Row) => {
    if (!mounted.current || mergeInFlight.current) return;
    const method = row.capability?.allowedMergeMethods[0];
    if (!method) return;
    mergeInFlight.current = row.key;
    setBusy(row.key);
    setError("");
    try {
      const result = await command({
        requestId: crypto.randomUUID(),
        executionId: row.executionId,
        operation: "source_control_merge",
        executionGeneration: row.executionGeneration,
        remoteIdentityHash: row.remote.remoteIdentityHash,
        reviewRequestNumber: row.review.number,
        mergeMethod: method,
        ...(row.proposalId ? { proposalItemId: row.proposalId } : {})
      });
      if (!mounted.current) return;
      if (
        result.operation === "source_control_merge" &&
        result.result.kind === "declined"
      ) {
        setError("Merge review declined. The pull request remains In review.");
        return;
      }
      if (
        result.operation === "source_control_merge" &&
        result.result.kind === "review_request_merge_result"
      ) {
        if (
          result.result.outcome === "pending" ||
          result.result.outcome === "unknown"
        ) {
          const operationId = result.result.operationId;
          window.localStorage.setItem(journalKey(row.key), operationId);
          setUnknown((value) => ({ ...value, [row.key]: operationId }));
        }
        setRevision((value) => value + 1);
        onWorkItemsChanged?.();
      }
    } catch {
      if (mounted.current)
        setError(
          "Merge could not be completed. Refresh the pull request before requesting another review."
        );
    } finally {
      mergeInFlight.current = null;
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => {
    if (!mergeRequestedItemId) {
      handledMergeRequest.current = null;
      return;
    }
    if (handledMergeRequest.current === mergeRequestedItemId || !rows.length)
      return;
    handledMergeRequest.current = mergeRequestedItemId;
    const matching = rows.filter(
      (row) => row.item?.id === mergeRequestedItemId
    );
    if (matching.length === 1 && matching[0]?.capability?.available)
      void merge(matching[0]);
    else
      setError(
        "Merge is unavailable here. Open the pull request on its provider."
      );
    onMergeRequestHandled?.();
  }, [mergeRequestedItemId, rows, onMergeRequestHandled]);
  const reconcile = async (row: Row) => {
    if (!mounted.current || mergeInFlight.current) return;
    const operationId = unknown[row.key];
    if (!operationId) return;
    mergeInFlight.current = row.key;
    setBusy(row.key);
    try {
      const result = await command({
        requestId: crypto.randomUUID(),
        executionId: row.executionId,
        operation: "source_control_merge_status",
        executionGeneration: row.executionGeneration,
        remoteIdentityHash: row.remote.remoteIdentityHash,
        operationId
      });
      if (!mounted.current) return;
      if (
        result.operation === "source_control_merge_status" &&
        result.result.kind === "review_request_merge_result" &&
        (result.result.outcome === "merged" ||
          result.result.outcome === "rejected")
      ) {
        window.localStorage.removeItem(journalKey(row.key));
        setUnknown((value) => {
          const next = { ...value };
          delete next[row.key];
          return next;
        });
      }
      setRevision((value) => value + 1);
      onWorkItemsChanged?.();
    } catch {
      if (mounted.current)
        setError(
          "Merge outcome is still unknown. Try read-only reconciliation again."
        );
    } finally {
      mergeInFlight.current = null;
      if (mounted.current) setBusy(null);
    }
  };
  const visibleRows = rows.filter((row) =>
    mode === "need"
      ? row.review.state === "open" &&
        Boolean(row.capability?.available) &&
        row.item?.prState !== "ready_to_merge"
      : row.review.state === "open" && !row.capability?.available
  );
  useEffect(() => {
    if (mode === "need") onNeedsCount?.(visibleRows.length);
  }, [mode, onNeedsCount, visibleRows.length]);
  useEffect(() => {
    onVisibleCount?.(visibleRows.length);
  }, [onVisibleCount, visibleRows.length]);
  const coveredWorkItemIds = rows.flatMap((row) =>
    row.item ? [row.item.id] : []
  );
  const coveredKey = [...new Set(coveredWorkItemIds)].sort().join(",");
  useEffect(() => {
    onCoveredWorkItemIds?.(coveredKey ? coveredKey.split(",") : []);
  }, [onCoveredWorkItemIds, coveredKey]);
  const displayedRows =
    limit === undefined ? visibleRows : visibleRows.slice(0, limit);
  return (
    <div className="hq-project-prs">
      {error ? <p role="alert">{error}</p> : null}
      {displayedRows.map((row) => (
        <div className="hq-project-prs__row" key={row.key}>
          <span className="hq-project-prs__avatar" aria-hidden="true">
            !
          </span>
          <div className="hq-project-prs__text">
            <b>
              {row.review.title} <span>PR #{row.review.number}</span>
            </b>
            <small>
              {row.checks.length
                ? row.checks
                    .map(
                      (check) =>
                        `${check.name} ${check.conclusion ?? check.state}`
                    )
                    .join(" · ")
                : "Checks unavailable"}
              {" · "}
              {row.capability?.reviewSummary?.headObjectId ===
              row.review.headObjectId
                ? `${row.capability.reviewSummary.approvedReviewCount}/${row.capability.reviewSummary.requiredReviewCount} reviews approved`
                : "Reviews unavailable"}
              {row.proposed ? " · Agent requested review" : ""}
            </small>
          </div>
          <div className="hq-project-prs__actions">
            {unknown[row.key] ? (
              <button
                type="button"
                disabled={busy === row.key}
                onClick={() => void reconcile(row)}
              >
                Check merge outcome
              </button>
            ) : null}
            {row.review.state === "open" &&
            row.capability?.available &&
            !unknown[row.key] ? (
              <button
                type="button"
                disabled={busy === row.key}
                onClick={() => void merge(row)}
              >
                Merge
              </button>
            ) : null}
            {row.review.state !== "open" ||
            !row.capability?.available ||
            unknown[row.key] ? (
              <a
                href={row.capability?.openUrl ?? row.review.webUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open on{" "}
                {providerLabel(row.capability?.provider ?? row.remote.provider)}
              </a>
            ) : null}
          </div>
        </div>
      ))}
      {!visibleRows.length && mode === "review" && showEmpty ? (
        <p>No other open pull requests.</p>
      ) : null}
    </div>
  );
}
