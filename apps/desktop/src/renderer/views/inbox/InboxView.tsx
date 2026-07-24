import type {
  CollaborationDurableSend,
  CollaborationSelection,
  CollaborationSnapshot
} from "@koed/shared/collaboration";
import { Button, Spinner } from "@koed/ui";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clipboard,
  Clock,
  MessageSquare,
  Network,
  RefreshCw
} from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { inboxModelFromSnapshot } from "./inbox-model.js";
import "./inbox.css";

export type ActiveApprovalItem = {
  expiresAt: string;
  id: string;
  onOpen?: () => void;
  scope: string;
  title: string;
};

export type InboxViewProps = {
  activeApprovals?: readonly ActiveApprovalItem[];
  error?: string | null;
  loading?: boolean;
  onOpenPreferences: (section: "team-connection" | "advanced") => void;
  onOpenSelection: (selection: CollaborationSelection) => void;
  onCopyOutbox?: (send: CollaborationDurableSend) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onRetryOutbox?: (send: CollaborationDurableSend) => void | Promise<void>;
  snapshot: CollaborationSnapshot | null;
};

function InboxSection({
  children,
  count,
  title
}: {
  children: ReactNode;
  count: number;
  title: string;
}) {
  if (count === 0) return null;
  return (
    <section className="koed-inbox-section">
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      <div className="koed-inbox-items">{children}</div>
    </section>
  );
}

function InboxRow({
  action,
  context,
  icon,
  onClick,
  title,
  trailing
}: {
  action?: ReactNode;
  context: string;
  icon: ReactNode;
  onClick?: () => void;
  title: string;
  trailing?: ReactNode;
}) {
  const content = (
    <>
      <span className="koed-inbox-row-icon">{icon}</span>
      <span className="koed-inbox-row-copy">
        <strong>{title}</strong>
        <span>{context}</span>
      </span>
      {action ?? trailing ?? <ChevronRight aria-hidden="true" />}
    </>
  );

  return onClick ? (
    <button className="koed-inbox-row" onClick={onClick} type="button">
      {content}
    </button>
  ) : (
    <div className="koed-inbox-row">{content}</div>
  );
}

export function InboxView({
  activeApprovals = [],
  error = null,
  loading = false,
  onOpenPreferences,
  onOpenSelection,
  onCopyOutbox,
  onRefresh,
  onRetryOutbox,
  snapshot
}: InboxViewProps) {
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), []);

  const model = useMemo(
    () => (snapshot ? inboxModelFromSnapshot(snapshot) : null),
    [snapshot]
  );

  if (loading && !snapshot) {
    return (
      <main
        aria-busy="true"
        className="koed-inbox koed-inbox-centered"
        ref={mainRef}
        tabIndex={-1}
      >
        <Spinner aria-hidden="true" />
        <p role="status">Loading authorized Inbox state…</p>
      </main>
    );
  }

  if (!snapshot || !model) {
    return (
      <main
        className="koed-inbox koed-inbox-centered"
        ref={mainRef}
        tabIndex={-1}
      >
        <Network aria-hidden="true" />
        <h1>Inbox unavailable</h1>
        <p>
          {error ??
            "Koed could not load the current authorized collaboration state."}
        </p>
        {onRefresh ? (
          <Button onClick={() => void onRefresh()} variant="outline">
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        ) : null}
      </main>
    );
  }

  const needsAttentionCount =
    model.failedOutbox.length +
    model.connectionFaults.length +
    model.sharedMemoryConflicts.length +
    activeApprovals.length;
  const empty =
    needsAttentionCount === 0 &&
    model.queuedOutbox.length === 0 &&
    model.unread.length === 0;

  return (
    <main className="koed-inbox" ref={mainRef} tabIndex={-1}>
      <header className="koed-inbox-header">
        <div>
          <h1>Inbox</h1>
          <p>
            Unread conversations and current items that need your attention.
          </p>
        </div>
        {onRefresh ? (
          <Button
            aria-label="Refresh Inbox"
            disabled={loading}
            onClick={() => void onRefresh()}
            size="icon"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      {error ? (
        <p className="koed-inbox-error" role="alert">
          {error}
        </p>
      ) : null}

      {empty ? (
        <div className="koed-inbox-empty">
          <Check aria-hidden="true" />
          <h2>You're caught up</h2>
          <p>No authorized unread conversations or current faults.</p>
        </div>
      ) : (
        <div className="koed-inbox-content">
          <InboxSection count={needsAttentionCount} title="Needs attention">
            {model.failedOutbox.map((item) => (
              <InboxRow
                action={
                  <span className="koed-inbox-row-actions">
                    {item.send.body && onCopyOutbox ? (
                      <Button
                        aria-label="Copy message text"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onCopyOutbox(item.send);
                        }}
                        size="icon"
                        title="Copy message text"
                        variant="ghost"
                      >
                        <Clipboard aria-hidden="true" />
                      </Button>
                    ) : null}
                    {item.send.retryable && onRetryOutbox ? (
                      <Button
                        onClick={(event) => {
                          event.stopPropagation();
                          void onRetryOutbox(item.send);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Retry
                      </Button>
                    ) : null}
                  </span>
                }
                context={`${item.context} · retained until delivered or authority is lost`}
                icon={<AlertTriangle aria-hidden="true" />}
                key={item.id}
                title={item.title}
              />
            ))}
            {activeApprovals.map((approval) => (
              <InboxRow
                context={`${approval.scope} · expires ${new Date(approval.expiresAt).toLocaleString()}`}
                icon={<Clock aria-hidden="true" />}
                key={approval.id}
                onClick={approval.onOpen}
                title={approval.title}
              />
            ))}
            {model.connectionFaults.map((fault) => (
              <InboxRow
                context={fault.description}
                icon={<Network aria-hidden="true" />}
                key={fault.id}
                onClick={() => onOpenPreferences("team-connection")}
                title={fault.title}
              />
            ))}
            {model.sharedMemoryConflicts.map((conflict) => (
              <InboxRow
                context={`${conflict.context} · ${conflict.description}`}
                icon={<AlertTriangle aria-hidden="true" />}
                key={conflict.id}
                onClick={() => onOpenSelection(conflict.selection)}
                title={conflict.title}
              />
            ))}
          </InboxSection>

          <InboxSection
            count={model.queuedOutbox.length}
            title="Waiting to send"
          >
            {model.queuedOutbox.map((item) => (
              <InboxRow
                action={
                  item.send.body && onCopyOutbox ? (
                    <Button
                      aria-label="Copy queued message text"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onCopyOutbox(item.send);
                      }}
                      size="icon"
                      title="Copy queued message text"
                      variant="ghost"
                    >
                      <Clipboard aria-hidden="true" />
                    </Button>
                  ) : null
                }
                context={`${item.context} · removal is unavailable while delivery is pending`}
                icon={<Clock aria-hidden="true" />}
                key={item.id}
                title={item.title}
              />
            ))}
          </InboxSection>

          <InboxSection count={model.unread.length} title="Unread">
            {model.unread.map((item) => (
              <InboxRow
                context={item.context}
                icon={<MessageSquare aria-hidden="true" />}
                key={item.id}
                onClick={() => onOpenSelection(item.selection)}
                title={item.title}
                trailing={
                  <span
                    aria-label={`${item.count} unread`}
                    className="koed-inbox-unread-count"
                  >
                    {item.count > 99 ? "99+" : item.count}
                  </span>
                }
              />
            ))}
          </InboxSection>
        </div>
      )}
    </main>
  );
}
