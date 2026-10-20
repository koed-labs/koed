import { useEffect, useState, type ReactNode } from "react";
import "../project/hq-project-pull-requests.css";
import type { WorkspaceProjectWorkItem } from "@koed/shared";
import type { ManagedConversationDesktopApi } from "../../../ipc/managed-conversation-protocol.js";
import type { ManagedProjectDesktopApi } from "../../../ipc/managed-project-protocol.js";
import { ExecutionMemoryChips } from "../memory/ExecutionMemoryChips.js";
import { latestRuntimeTurn } from "../memory/execution-memory-chips.js";
import type { SharedDispatchBinding } from "./shared-project-store.js";

type NativeReview = {
  generation: number;
  remoteIdentityHash: string;
  number: number;
  method: "merge" | "squash" | "rebase";
};

/** Private controls exist only for the current Personal owner's exact Team dispatch binding. */
export function SharedProjectExecution({
  binding,
  item,
  api,
  managedProject,
  ownerId,
  profileKey,
  projectId,
  panelHost,
  panelActive,
  onPanelOpen,
  onPanelClose,
  onOpenMessage,
  onTeamRefresh,
  title,
  dueControl
}: {
  binding: SharedDispatchBinding;
  item: WorkspaceProjectWorkItem;
  api: ManagedConversationDesktopApi;
  managedProject?: ManagedProjectDesktopApi | null;
  ownerId: string;
  profileKey: string;
  projectId: string;
  panelHost?: HTMLElement | null;
  panelActive: boolean;
  onPanelOpen: () => void;
  onPanelClose: () => void;
  onOpenMessage?: React.ComponentProps<
    typeof ExecutionMemoryChips
  >["onOpenMessage"];
  onTeamRefresh: () => void;
  title?: ReactNode;
  dueControl?: ReactNode;
}) {
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<ManagedConversationDesktopApi["runtime"]>
  > | null>(null);
  const [review, setReview] = useState<NativeReview | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const prUrl = item.prUrl;
  useEffect(() => {
    let live = true;
    setRuntime(null);
    setReview(null);
    setUnknown(null);
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const result = await api.runtime(binding.executionId);
        if (live) setRuntime(result);
      } catch {
        if (live) setRuntime(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, binding.executionId, ownerId, profileKey, projectId]);
  useEffect(() => {
    let live = true;
    setReview(null);
    if (!runtime || !prUrl || !managedProject || item.status !== "review")
      return;
    const load = async () => {
      try {
        const url = new URL(prUrl);
        if (url.protocol !== "https:" || url.username || url.password) return;
        const number = Number(
          url.pathname.match(/\/(?:pull|merge_requests)\/(\d+)\/?$/)?.[1]
        );
        if (!Number.isSafeInteger(number) || number <= 0) return;
        const base = {
          requestId: crypto.randomUUID(),
          executionId: binding.executionId
        };
        const command = managedProject.command;
        const remotes = await command({
          ...base,
          operation: "source_control",
          sourceControlOperation: {
            contractVersion: 1,
            executionId: binding.executionId,
            executionGeneration: runtime.executionGeneration,
            kind: "remotes"
          }
        });
        if (
          remotes.operation !== "source_control" ||
          remotes.result.kind !== "remotes"
        )
          return;
        for (const remote of remotes.result.remotes) {
          if (
            remote.connectionState !== "connected" ||
            !remote.capabilities.includes("review_request_read") ||
            remote.host !== url.hostname
          )
            continue;
          const request = await command({
            ...base,
            operation: "source_control",
            sourceControlOperation: {
              contractVersion: 1,
              executionId: binding.executionId,
              executionGeneration: runtime.executionGeneration,
              kind: "review_request",
              remoteIdentityHash: remote.remoteIdentityHash,
              number
            }
          });
          if (
            request.operation !== "source_control" ||
            request.result.kind !== "review_request" ||
            request.result.reviewRequest.webUrl !== url.href ||
            request.result.reviewRequest.state !== "open"
          )
            continue;
          const capability = await command({
            ...base,
            operation: "source_control_merge_capability",
            executionGeneration: runtime.executionGeneration,
            remoteIdentityHash: remote.remoteIdentityHash,
            reviewRequestNumber: number
          });
          if (
            capability.operation !== "source_control_merge_capability" ||
            capability.result.kind !== "review_request_merge_capability" ||
            !capability.result.available ||
            !capability.result.allowedMergeMethods.length
          )
            continue;
          if (live)
            setReview({
              generation: runtime.executionGeneration,
              remoteIdentityHash: remote.remoteIdentityHash,
              number,
              method: capability.result.allowedMergeMethods[0]!
            });
          return;
        }
      } catch {
        if (live) setReview(null);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [
    api,
    managedProject,
    binding.executionId,
    runtime?.executionGeneration,
    prUrl,
    item.status
  ]);
  const merge = async () => {
    if (!review || !managedProject || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await managedProject.command({
        requestId: crypto.randomUUID(),
        executionId: binding.executionId,
        operation: "source_control_merge",
        executionGeneration: review.generation,
        remoteIdentityHash: review.remoteIdentityHash,
        reviewRequestNumber: review.number,
        mergeMethod: review.method
      });
      if (result.operation !== "source_control_merge") return;
      if (result.result.kind === "declined") {
        setError("Merge review declined. The pull request remains In review.");
      } else if (result.result.kind === "review_request_merge_result") {
        if (
          result.result.outcome === "pending" ||
          result.result.outcome === "unknown"
        )
          setUnknown(result.result.operationId);
        onTeamRefresh();
      }
    } catch {
      setError(
        "Merge could not be completed. Refresh the pull request before requesting another review."
      );
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (!unknown || !review || !managedProject || busy) return;
    setBusy(true);
    try {
      const result = await managedProject.command({
        requestId: crypto.randomUUID(),
        executionId: binding.executionId,
        operation: "source_control_merge_status",
        executionGeneration: review.generation,
        remoteIdentityHash: review.remoteIdentityHash,
        operationId: unknown
      });
      if (
        result.operation === "source_control_merge_status" &&
        result.result.kind === "review_request_merge_result" &&
        ["merged", "rejected"].includes(result.result.outcome)
      )
        setUnknown(null);
      onTeamRefresh();
    } catch {
      setError(
        "Merge outcome is still unknown. Try read-only reconciliation again."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="hq-project-view__work-item-text">
        {title}
        <span className="hq-execution-memory__secondary">
          {dueControl}
          <ExecutionMemoryChips
            api={api}
            ownerId={ownerId}
            profileKey={profileKey}
            projectId={projectId}
            executionId={binding.executionId}
            executionGeneration={runtime?.executionGeneration}
            providerTurnId={
              runtime
                ? latestRuntimeTurn(
                    runtime.items,
                    undefined,
                    runtime.executionGeneration
                  )
                : null
            }
            variant={item.status === "blocked" ? "why" : "count"}
            panelHost={panelHost}
            panelActive={panelActive}
            onPanelOpen={onPanelOpen}
            onPanelClose={onPanelClose}
            onOpenMessage={onOpenMessage}
          />
          <small>
            {item.stepLabel ??
              (item.status === "blocked" ? "Needs you" : "Agent working")}
          </small>
          {error ? <small role="alert">{error}</small> : null}
        </span>
      </span>
      <span className="hq-project-prs__actions">
        {review && !unknown ? (
          <button type="button" disabled={busy} onClick={() => void merge()}>
            Merge
          </button>
        ) : null}
        {unknown ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void reconcile()}
          >
            Check merge outcome
          </button>
        ) : null}
      </span>
    </>
  );
}
