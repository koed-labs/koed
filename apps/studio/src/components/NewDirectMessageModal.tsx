"use client";

import { useEffect, useState } from "react";
import { Search, Users, X } from "lucide-react";
import { COLLABORATION_MAX_DM_PARTICIPANTS } from "@koed/shared/collaboration";

/** Pick one enabled Team member or start a group chat with the other members. */
export function NewDirectMessageModal({
  members,
  principalUserId,
  onClose,
  onStart
}: {
  members: Array<{ id: string; name: string }>;
  principalUserId: string;
  onClose: () => void;
  onStart: (participantUserIds: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = members.filter((member) => member.id !== principalUserId);
  const trimmedQuery = query.trim().toLocaleLowerCase();
  const filtered = trimmedQuery
    ? others.filter((member) => member.name.toLocaleLowerCase().includes(trimmedQuery))
    : others;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const start = async (ids: string[]) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(ids);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the direct message.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="new-team-dm-title" className="flex max-h-[calc(100vh-2rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4">
          <h2 id="new-team-dm-title" className="text-base font-semibold text-foreground">New direct message</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary disabled:opacity-50"><X className="h-4 w-4" /></button>
        </div>
        {others.length > 0 && <div className="flex items-center gap-2 border-b border-border px-5 py-2.5"><Search className="h-3.5 w-3.5 flex-shrink-0 text-subtle" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search teammates" aria-label="Search teammates" className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle" /></div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {others.length === 0 ? <p className="px-2 py-3 text-sm text-subtle">No other teammates on this team yet.</p> : filtered.length === 0 ? <p className="px-2 py-3 text-sm text-subtle">No teammates match your search.</p> : <div className="space-y-0.5">
            {filtered.map((member) => <button key={member.id} type="button" disabled={busy} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:opacity-50" onClick={() => void start([member.id])}>
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-hover text-[11px] font-medium text-foreground-secondary">{member.name.slice(0, 1).toUpperCase()}</span>
              <span className="truncate text-sm text-foreground-secondary">{member.name}</span>
            </button>)}
            {!trimmedQuery && others.length > 1 && <button type="button" disabled={busy || others.length + 1 > COLLABORATION_MAX_DM_PARTICIPANTS} title={others.length + 1 > COLLABORATION_MAX_DM_PARTICIPANTS ? `Group direct messages support up to ${COLLABORATION_MAX_DM_PARTICIPANTS} participants.` : undefined} className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-border px-3 pt-3 pb-2 text-left transition-colors hover:bg-surface-hover disabled:opacity-50" onClick={() => void start(others.map((member) => member.id))}>
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface-hover text-subtle"><Users className="h-3.5 w-3.5" /></span>
              <span className="truncate text-sm text-foreground-secondary">{others.map((member) => member.name).join(", ")}</span>
            </button>}
          </div>}
          {!trimmedQuery && others.length + 1 > COLLABORATION_MAX_DM_PARTICIPANTS && <p className="px-2 py-2 text-xs text-subtle">Group direct messages support up to {COLLABORATION_MAX_DM_PARTICIPANTS} participants.</p>}
        </div>
        {error && <p role="alert" className="border-t border-border px-5 py-3 text-xs text-warning">{error}</p>}
      </div>
    </div>
  );
}
