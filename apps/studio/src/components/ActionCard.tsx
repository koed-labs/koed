"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle, Bot, ChevronRight, Inbox, RotateCcw, Users, X } from "lucide-react";
import {
  TIER_LABEL,
  TIER_ORDER,
  type ActionButton,
  type ActionItem,
  type ActionKind,
  type ActionTarget,
} from "@/lib/attention";
import { relativeTime, resolveAgent } from "@/lib/collab";
import { teamTone } from "@/lib/identity";
import { AgentAvatarView } from "./AgentAvatarView";
import { CollapsibleSection } from "./Collapsible";
import type { CollabView } from "./CollabSessionContext";
import { useCollabSession } from "./CollabSessionContext";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";

// Opening one of these counts as having seen it - nobody is blocked on
// them, so they quietly clear themselves once you've looked. Items that
// block work (an agent waiting, a merge on hold) stay until the thing
// itself is resolved, however many times you open them.
const CLEAR_ON_OPEN: ActionKind[] = ["replies", "findings", "pr-approved", "memory-ready", "agent-idle"];

// Navigates to an item's target from anywhere in the app - Home (Personal),
// or For you on any team. A target on the team you're already in just
// switches the view; a target on another team switches teams first.
export function useOpenTarget() {
  const router = useRouter();
  const pathname = usePathname();
  const { activeTeamId, openCollaborative } = useWorkspace();
  const { openView } = useCollabSession();

  return (target: ActionTarget) => {
    if (target.type === "route") {
      router.push(target.href);
      return;
    }
    const { landing } = target;
    const nextView: CollabView =
      landing.view === "inbox"
        ? { type: "inbox" }
        : landing.view === "agent" && landing.viewId
          ? { type: "agent", id: landing.viewId }
          : landing.view === "channel" && landing.viewId
            ? { type: "channel", id: landing.viewId }
            : { type: "square" };
    if (activeTeamId === landing.teamId) {
      openView(nextView);
      if (pathname !== "/collaboration") router.push("/collaboration");
      return;
    }
    openCollaborative(landing);
    router.push("/collaboration");
  };
}

function useRunButton(clearAction: (id: string) => void) {
  const openTarget = useOpenTarget();
  const {
    acceptChannelInvite,
    declineChannelInvite,
    retryMemoryItem,
    markWhisperRead,
  } = useWorkspace();

  return (button: ActionButton, item: ActionItem) => {
    switch (button.op) {
      case "open":
        if (CLEAR_ON_OPEN.includes(item.kind)) clearAction(item.id);
        openTarget(button.target);
        return;
      case "accept-invite":
        acceptChannelInvite(button.messageId);
        return;
      case "decline-invite":
        declineChannelInvite(button.messageId);
        return;
      case "retry-memory":
        retryMemoryItem(button.itemId);
        return;
      case "confirm-memory-check":
        markWhisperRead(button.whisperId);
        return;
      case "correct-message":
        // Handled inline by the row (it needs a text field first).
        return;
      case "unavailable":
        return;
    }
  };
}

function SystemIcon({ kind }: { kind: ActionKind }) {
  if (kind === "memory-failed") {
    return (
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-danger/10 text-danger">
        <AlertCircle className="h-3.5 w-3.5" />
      </span>
    );
  }
  const Icon = kind === "memory-ready" ? Inbox : kind === "invite" ? Users : Bot;
  return (
    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-surface-hover text-muted">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function ActorAvatar({ item }: { item: ActionItem }) {
  const { workspace } = useWorkspace();
  if (item.actor.kind === "agent") {
    const agentId = item.actor.agentId;
    const assignment = workspace.projectAgents.find((agent) => agent.id === agentId);
    const agent = assignment ? resolveAgent(assignment, workspace.agentDefinitions) : null;
    if (agent) {
      return (
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
          <AgentAvatarView image={agent.avatar?.image} name={agent.name} size="sm" />
        </span>
      );
    }
  }
  if (item.actor.kind === "human") {
    return (
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-medium text-foreground-secondary">
        {item.actor.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <SystemIcon kind={item.kind} />;
}

// "Team Alpha · #general" with the team's identity color, or just the
// personal-side label. Color here only ever means "which team" - never
// urgency - so it can't be confused with the tier marker on the row.
export function SourceTag({ item }: { item: ActionItem }) {
  if (item.source.side === "personal") {
    return <span className="min-w-0 max-w-[50%] flex-shrink truncate text-subtle">{item.source.label}</span>;
  }
  const tone = teamTone(item.source.teamId);
  return (
    <span className="flex min-w-0 max-w-[50%] flex-shrink items-center gap-1.5 text-subtle">
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone.solid}`} />
      <span className="truncate">
        {item.source.teamName} · {item.source.label}
      </span>
    </span>
  );
}

// A decision you can make right in the list, without going anywhere -
// the only buttons a row shows. Anything that just takes you somewhere is
// the row itself (click it), so the list isn't a column of identical
// white buttons.
function isInlineDecision(button: ActionButton | undefined) {
  return Boolean(button && button.op !== "open");
}

export function ActionRow({ item, clearAction }: { item: ActionItem; clearAction: (id: string) => void }) {
  const run = useRunButton(clearAction);
  const openTarget = useOpenTarget();
  const { workspace, editChannelMessage, markWhisperRead } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Where clicking the row itself goes: the main action if it navigates,
  // otherwise the secondary one if that does (e.g. "Look first" on a PR).
  const rowTarget = [item.primary, item.secondary].find(
    (button): button is ActionButton & { op: "open" } => Boolean(button && button.op === "open")
  );
  const decisions = [item.primary, item.secondary].filter(
    (button): button is ActionButton => isInlineDecision(button)
  );
  const blocking = item.tier === "blocking";
  const detail = item.quote ?? item.why;

  const press = (button: ActionButton) => {
    if (button.op === "correct-message") {
      const message = workspace.channelMessages.find((entry) => entry.id === button.messageId);
      setDraft(message?.content ?? "");
      setEditing(true);
      return;
    }
    run(button, item);
  };

  const saveCorrection = () => {
    if (item.primary.op !== "correct-message" || !draft.trim()) return;
    const { messageId, whisperId, channelId, teamId } = item.primary;
    editChannelMessage(messageId, draft);
    markWhisperRead(whisperId);
    setEditing(false);
    openTarget({ type: "collab", landing: { teamId, projectId: null, view: "channel", viewId: channelId } });
  };

  return (
    <li className="group relative">
      {blocking && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
      <div
        role={rowTarget ? "button" : undefined}
        tabIndex={rowTarget ? 0 : undefined}
        onClick={() => rowTarget && !editing && run(rowTarget, item)}
        onKeyDown={(event) => {
          if (rowTarget && !editing && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            run(rowTarget, item);
          }
        }}
        title={item.quote ? `${item.why}\n\n“${item.quote}”` : item.why}
        className={`flex items-center gap-3 px-3 py-2.5 transition-colors ${
          rowTarget && !editing ? "cursor-pointer hover:bg-surface-hover/50" : ""
        }`}
      >
        <ActorAvatar item={item} />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm ${blocking ? "font-medium text-foreground" : "text-foreground"}`}>
            {item.title}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-xs">
            <SourceTag item={item} />
            <span className="text-faint">·</span>
            <span className="min-w-0 flex-1 truncate text-muted">{detail}</span>
            <span className="flex-shrink-0 text-faint">{relativeTime(item.at)}</span>
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {!editing &&
            decisions.map((button, index) => (
              <button
                key={button.label}
                type="button"
                disabled={button.op === "unavailable"}
                title={button.op === "unavailable" ? button.reason : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  press(button);
                }}
                className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                  button.op === "unavailable"
                    ? "cursor-not-allowed text-faint"
                    : index === 0
                    ? "border border-border-strong text-foreground hover:bg-surface-hover"
                    : "text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {button.label}
              </button>
            ))}
          {rowTarget && !editing && (
            <span className="flex items-center gap-0.5 pl-1 text-xs text-subtle">
              <span className="hidden group-hover:inline">{rowTarget.label}</span>
              <ChevronRight className="h-3.5 w-3.5 text-faint group-hover:text-foreground-secondary" />
            </span>
          )}
          <Tooltip content="Clear until something new happens" side="left">
            <button
              type="button"
              aria-label="Clear"
              onClick={(event) => {
                event.stopPropagation();
                clearAction(item.id);
              }}
              className="rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground-secondary focus:opacity-100 group-hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>
      {editing && (
        <div className="space-y-2 px-3 pb-3 pl-12">
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-background p-2.5 text-sm text-foreground outline-none focus:border-border-strong"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="rounded-md bg-chip px-3 py-1.5 text-xs font-medium text-chip-foreground hover:bg-chip-hover"
              onClick={saveCorrection}
            >
              Post correction
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <span className="text-[11px] text-subtle">Edits your message in the channel for everyone.</span>
          </div>
        </div>
      )}
    </li>
  );
}

// A capped list: the first few rows, then "Show N more" - so a busy day
// doesn't turn the page into a scroll marathon.
export function ActionList({ items, clearAction, limit = 5 }: { items: ActionItem[]; clearAction: (id: string) => void; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const hidden = items.length - shown.length;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
      <ul className="divide-y divide-border">
        {shown.map((item) => (
          <ActionRow key={item.id} item={item} clearAction={clearAction} />
        ))}
      </ul>
      {(hidden > 0 || (expanded && items.length > limit)) && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="w-full border-t border-border px-3 py-2 text-left text-xs text-subtle transition-colors hover:bg-surface-hover/50 hover:text-foreground-secondary"
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

// Items grouped under "Blocking work / Waiting on your reply / Worth a
// look", most urgent group first. Each group collapses on its own (and
// remembers it), and "Worth a look" starts collapsed - nobody is stuck on it.
export function ActionGroups({ items, idPrefix, clearAction }: { items: ActionItem[]; idPrefix: string; clearAction: (id: string) => void }) {
  return (
    <div className="space-y-5">
      {TIER_ORDER.map((tier) => {
        const group = items.filter((item) => item.tier === tier);
        if (group.length === 0) return null;
        return (
          <CollapsibleSection
            key={tier}
            id={`${idPrefix}.${tier}`}
            title={TIER_LABEL[tier]}
            count={group.length}
            defaultCollapsed={tier === "fyi"}
          >
            <ActionList items={group} clearAction={clearAction} />
          </CollapsibleSection>
        );
      })}
    </div>
  );
}

// Cleared items stay one click away - clearing is "not now", never "gone".
export function ClearedItems({ items, restoreAction }: { items: ActionItem[]; restoreAction: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1.5 text-xs text-subtle transition-colors hover:text-foreground-secondary"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        {items.length} cleared
      </button>
      {open && (
        <div className="mt-2 space-y-0.5">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover/50">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground-secondary">{item.title}</p>
                <p className="text-[11px]">
                  <SourceTag item={item} />
                </p>
              </div>
              <button
                type="button"
                onClick={() => restoreAction(item.id)}
                className="flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              >
                <RotateCcw className="h-3 w-3" />
                Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
