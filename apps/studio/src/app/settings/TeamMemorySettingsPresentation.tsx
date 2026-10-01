export type TeamMemoryTab = "members" | "memory" | "my-shares";

export type TeamMemoryMember = {
  userId: string;
  displayName: string | null;
  enabled: boolean;
  version: number;
};

export type RetainedTeamMemoryItem = {
  shareGrantId: string;
  logicalMemoryId: string;
  title: string;
  contributorLabel: string;
  grantVersion: number;
  sourceUpdateState: "active" | "stopped";
  retainedAt: string;
};

export type PresentedTeamMemoryShare = {
  key: string;
  title: string;
  teamAndMode: string;
  status: string;
  actions: Array<
    | { key: string; kind: "label"; label: string; className: string }
    | {
        key: string;
        kind?: "button";
        label: string;
        className: string;
        disabled: boolean;
      }
  >;
};

export function TeamMemoryMembersPanel({
  members,
  busy,
  onChange
}: {
  members: TeamMemoryMember[];
  busy: boolean;
  onChange: (member: TeamMemoryMember, enabled: boolean) => void;
}) {
  return (
    <div
      role="tabpanel"
      className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface/40"
    >
      {members.length === 0 ? (
        <p className="p-4 text-xs text-muted">
          Loading member retention settings…
        </p>
      ) : (
        members.map((member) => (
          <div
            key={member.userId}
            className="flex items-center gap-3 px-4 py-3"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-foreground-secondary">
              {member.displayName?.trim() || "Team member"}
            </span>
            <span className="text-xs text-muted">Retain new shares</span>
            <button
              type="button"
              role="switch"
              aria-checked={member.enabled}
              aria-label={`Retain new shares for ${member.displayName || "Team member"}`}
              disabled={busy}
              onClick={() => onChange(member, !member.enabled)}
              className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${member.enabled ? "bg-accent" : "bg-border-strong"}`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${member.enabled ? "translate-x-4" : "translate-x-0.5"}`}
              />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export function TeamMemoryRetainedItemsPanel<T extends RetainedTeamMemoryItem>({
  items,
  cursor,
  busy,
  pageBusy,
  emptyText,
  onRemove,
  onLoadMore
}: {
  items: T[];
  cursor: string | null;
  busy: boolean;
  pageBusy: boolean;
  emptyText: string;
  onRemove: (item: T) => void;
  onLoadMore: () => void;
}) {
  return (
    <div role="tabpanel" className="mt-3 space-y-2">
      {items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">
          {emptyText}
        </p>
      ) : (
        items.map((item) => (
          <article
            key={item.shareGrantId}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium text-foreground">
                {item.title}
              </h3>
              <p className="mt-1 truncate text-xs text-muted">
                Contributed by {item.contributorLabel}
              </p>
              <p className="mt-1 text-[11px] text-subtle">
                Updates {item.sourceUpdateState} · Retained{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium"
                }).format(new Date(item.retainedAt))}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(item)}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted hover:border-warning/40 hover:text-warning disabled:opacity-50"
            >
              Remove
            </button>
          </article>
        ))
      )}
      {cursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={onLoadMore}
          className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
        >
          {pageBusy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

export function TeamMemoryShareList({
  shares,
  emptyText,
  cursor,
  busy,
  pageBusy,
  onAction,
  onLoadMore
}: {
  shares: PresentedTeamMemoryShare[];
  emptyText: string;
  cursor: boolean;
  busy: boolean;
  pageBusy: boolean;
  onAction: (shareKey: string, actionKey: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <div role="tabpanel" className="mt-3 space-y-2">
      {shares.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface/40 p-4 text-xs text-muted">
          {emptyText}
        </p>
      ) : (
        shares.map((share) => (
          <article
            key={share.key}
            className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium text-foreground">
                {share.title}
              </h3>
              <p className="mt-1 truncate text-xs text-muted">
                {share.teamAndMode}
              </p>
              <p className="mt-1 text-[11px] text-subtle">{share.status}</p>
            </div>
            {share.actions.map((action) =>
              action.kind === "label" ? (
                <span key={action.key} className={action.className}>
                  {action.label}
                </span>
              ) : (
                <button
                  key={action.key}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => onAction(share.key, action.key)}
                  className={action.className}
                >
                  {action.label}
                </button>
              )
            )}
          </article>
        ))
      )}
      {cursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={onLoadMore}
          className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
        >
          {pageBusy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

export function TeamMemoryRemoveDialog({
  item,
  busy,
  removing,
  headingId,
  onCancel,
  onConfirm
}: {
  item: RetainedTeamMemoryItem;
  busy: boolean;
  removing: boolean;
  headingId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h3 id={headingId} className="text-sm font-semibold text-foreground">
          Remove retained Team memory?
        </h3>
        <p className="mt-2 text-sm text-foreground-secondary">
          “{item.title}” by {item.contributorLabel} will no longer be available
          to Team members.
        </p>
        <p className="mt-2 text-xs text-muted">
          This does not change the contributor’s Personal Memory or copies in
          other Teams.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-xs text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md bg-warning px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {removing ? "Removing…" : "Remove memory"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function TeamMemoryTabNavigation({
  tab,
  hosted,
  onChange
}: {
  tab: TeamMemoryTab;
  hosted: boolean;
  onChange: (tab: TeamMemoryTab) => void;
}) {
  const tabs: Array<[TeamMemoryTab, string]> = hosted
    ? [
        ["members", "Members"],
        ["memory", "Team memory"],
        ["my-shares", "My shares"]
      ]
    : [
        ["members", "Members"],
        ["memory", "Memory"],
        ["my-shares", "My shares"]
      ];
  const buttons = tabs.map(([value, label]) => (
    <button
      key={value}
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => onChange(value)}
      className={`border-b-2 px-3 py-2 text-xs ${tab === value ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
    >
      {label}
    </button>
  ));
  return hosted ? (
    <nav
      className="mt-5 flex gap-1 border-b border-border"
      aria-label="Team memory settings"
    >
      {buttons}
    </nav>
  ) : (
    <div
      className="mt-4 flex gap-1 border-b border-border"
      role="tablist"
      aria-label="Team memory settings"
    >
      {buttons}
    </div>
  );
}

export function TeamMemoryAdminOnlyMessage() {
  return (
    <p role="tabpanel" className="mt-3 text-xs text-muted">
      Only Team admins can manage member retention and retained Team memory.
    </p>
  );
}
