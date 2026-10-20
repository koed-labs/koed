import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import "./hq-chat-delete.css";

export type ChatDeleteRequest = {
  projectId: string;
  sessionId: string;
  title: string;
  mode: "delete" | "forget";
  running: boolean | null;
};
export type ChatDeleteNotice = {
  kind: "deleted" | "pending" | "forget_pending" | "forgotten" | "error";
  sessionId: string;
  batchId?: string;
  message: string;
};

export function HqChatDeleteControls({
  request,
  notice,
  busy,
  onCancel,
  onConfirm,
  onDismiss,
  onUndo,
  onRetry
}: {
  request: ChatDeleteRequest | null;
  notice: ChatDeleteNotice | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onRetry: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const controls = useRef({ busy, onCancel });
  controls.current = { busy, onCancel };
  useEffect(() => {
    if (!request) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current
      ?.querySelector<HTMLElement>("button:not(:disabled)")
      ?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !controls.current.busy) {
        event.preventDefault();
        controls.current.onCancel();
      }
      if (event.key !== "Tab") return;
      const buttons = [
        ...(dialog.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)"
        ) ?? [])
      ];
      if (!buttons.length) return;
      const first = buttons[0]!;
      const last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [request?.sessionId, request?.mode]);
  return (
    <>
      {request ? (
        <div className="hq-chat-delete__scrim">
          <div
            ref={dialog}
            className="hq-chat-delete__dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="hq-chat-delete-title"
            aria-describedby="hq-chat-delete-description"
          >
            <h3 id="hq-chat-delete-title">
              {request.mode === "forget"
                ? "Forget this chat?"
                : "Delete this chat?"}
            </h3>
            <p id="hq-chat-delete-description">
              {request.mode === "forget" ? (
                <>
                  <strong>{request.title}</strong> will disappear from your
                  chats and Personal recall. You can undo this for 7 days.
                </>
              ) : (
                <>
                  <strong>{request.title}</strong> will move to Deleted for 30
                  days. Its memory stays available to Koed.
                </>
              )}
            </p>
            <p>
              {request.running === null
                ? "Checking whether an agent is working in this chat…"
                : request.running
                  ? "An agent is working in this chat. Koed will stop it after you confirm."
                  : "No agent is currently working in this chat."}
            </p>
            <div className="hq-chat-delete__actions">
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="hq-chat-delete__danger"
                onClick={onConfirm}
                disabled={busy || request.running === null}
              >
                {busy
                  ? "Working…"
                  : request.mode === "forget"
                    ? "Forget chat"
                    : "Delete chat"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {notice ? (
        <div className="hq-chat-delete__notice" role="status">
          <span>{notice.message}</span>
          {notice.kind === "deleted" || notice.kind === "forgotten" ? (
            <button type="button" onClick={onUndo}>
              Undo
            </button>
          ) : null}
          {notice.kind === "pending" || notice.kind === "forget_pending" ? (
            <button type="button" onClick={onRetry}>
              Check status
            </button>
          ) : null}
          <button type="button" aria-label="Dismiss" onClick={onDismiss}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
