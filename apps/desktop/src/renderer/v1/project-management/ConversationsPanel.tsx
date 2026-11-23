import { useState, type ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuTrigger,
  Input
} from "@koed-labs/ui";
import {
  ChevronRight,
  Ellipsis,
  EyeOff,
  Folder,
  FolderSearch,
  GitFork,
  Hand,
  Lock,
  MessageCircle,
  Plus,
  Trash2
} from "lucide-react";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import { personalFolderScopeId } from "@koed-labs/shared/personal-desktop";
import { AiClientLogo } from "../../views/personal/AiClientLogo.js";
import { conversationActivity } from "../ProjectSidebar.js";
import {
  directMembership,
  excludedMembership,
  unresolvedMembership
} from "./conversation-organization.js";
import { CountCoin } from "./ProjectCoins.js";
import {
  settingsMatchingSources,
  settingsMembership,
  type MembershipDraft,
  type ProjectSettingsDraft,
  type SettingsConversation,
  type SettingsSource
} from "./project-settings-model.js";
import {
  suggestionApprovalKey,
  type FolderProposal
} from "./folder-hint-suggestion.js";
import { suggestionReason } from "./proposal-text.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

export type ConversationFacts = ReadonlyMap<
  string,
  { client?: SupportedAiClientDriverId; latestAt?: string }
>;

const inProject = (draft: ProjectSettingsDraft, c: SettingsConversation) =>
  !excludedMembership(c.explanation) &&
  (c.explanation.included || settingsMatchingSources(draft, c).length > 0);

/** Pending membership changes, for the footer: "1 to add · 1 to remove". */
export function membershipSummary(
  draft: ProjectSettingsDraft,
  addedSuggestions: number
): { add: number; remove: number } {
  let add = addedSuggestions,
    remove = 0;
  // Against the saved state, so adding or removing a rule counts too.
  for (const row of draft.conversations) {
    const now = settingsMembership(draft, row).included;
    const before = row.explanation.included;
    if (now && !before) add += 1;
    if (!now && before) remove += 1;
  }
  return { add, remove };
}

const isRule = (s: SettingsSource) =>
  (s.kind === "repository" || s.kind === "folder") && !!s.target;

function folderPickerDetails(sources: readonly SettingsSource[]) {
  const folders = sources.flatMap(({ id, detail, target }) =>
    target?.kind === "folder" ? [{ id, detail, folder: target.folder }] : []
  );
  const detailCounts = new Map<string, number>();
  for (const { detail } of folders)
    detailCounts.set(detail, (detailCounts.get(detail) ?? 0) + 1);

  const labelCounts = new Map<string, number>();
  const labels = folders.map(({ id, detail, folder }) => {
    const label =
      (detailCounts.get(detail) ?? 0) > 1
        ? `${detail} · ${folder.originatingDeviceId}`
        : detail;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    return { id, label, folder };
  });
  return new Map(
    labels.map(({ id, label, folder }) => [
      id,
      (labelCounts.get(label) ?? 0) > 1
        ? `${label} · ${folder.directoryIncarnationId}`
        : label
    ])
  );
}

/** The Project's Folder and Git Anchor rules: saved ones, including any staged
 * for removal, and new ones staged for adding. */
export function projectRules(draft: ProjectSettingsDraft): SettingsSource[] {
  const rules = draft.sources.filter(
    (s) => isRule(s) && (s.inclusionId || draft.selectedSources.has(s.id))
  );
  return [
    ...rules.filter((s) => s.kind === "repository"),
    ...rules.filter((s) => s.kind === "folder")
  ];
}

/** Rules this Conversation matches, whether or not they are still selected. */
const rulesFor = (
  rules: readonly SettingsSource[],
  row: SettingsConversation
) =>
  rules.filter((source) =>
    source.inclusionId
      ? row.explanation.reasons.some(
          (r) => r.inclusionId === source.inclusionId
        )
      : source.previewSessions?.includes(row.sessionId)
  );

type RuleState = "saved" | "adding" | "removing";
const ruleState = (
  draft: ProjectSettingsDraft,
  source: SettingsSource
): RuleState =>
  !draft.selectedSources.has(source.id)
    ? "removing"
    : source.inclusionId
      ? "saved"
      : "adding";

const ruleNoun = (kind: SettingsSource["kind"]) =>
  kind === "repository" ? "Git Anchor" : "Folder";

type MemberGroup = {
  key: string;
  rule?: SettingsSource;
  members: SettingsConversation[];
  excluded: SettingsConversation[];
};

/** Rules: Conversations in the Project, grouped by the rule that brings each Conversation in. A
 * Conversation two rules match is listed once, under the first. */
export function memberGroups(draft: ProjectSettingsDraft): MemberGroup[] {
  const rules = projectRules(draft);
  const groups = new Map<string, MemberGroup>(
    rules.map((rule) => [
      rule.id,
      { key: rule.id, rule, members: [], excluded: [] }
    ])
  );
  const direct: MemberGroup = { key: "direct", members: [], excluded: [] };
  const excludedOnly: MemberGroup = {
    key: "excluded",
    members: [],
    excluded: []
  };
  for (const row of draft.conversations) {
    const matched = rulesFor(rules, row);
    // A rule still in the Project wins over one being removed.
    const home =
      matched.find((r) => draft.selectedSources.has(r.id)) ?? matched[0];
    if (excludedMembership(row.explanation)) {
      (home ? groups.get(home.id)! : excludedOnly).excluded.push(row);
      continue;
    }
    if (home) groups.get(home.id)!.members.push(row);
    else if (inProject(draft, row) || settingsMembership(draft, row).included)
      direct.members.push(row);
  }
  return [
    ...groups.values(),
    ...(direct.members.length > 0 ? [direct] : []),
    ...(excludedOnly.excluded.length > 0 ? [excludedOnly] : [])
  ];
}

/** Conversations that leave the Project if this rule goes: no other selected
 * rule matches them and they were not added directly. */
export function leavingWith(
  draft: ProjectSettingsDraft,
  rule: SettingsSource
): number {
  const rules = projectRules(draft);
  return draft.conversations.filter((row) => {
    if (
      excludedMembership(row.explanation) ||
      draft.memberships[row.sessionId]?.included === false
    )
      return false;
    const matched = rulesFor(rules, row);
    if (!matched.some((r) => r.id === rule.id)) return false;
    return (
      !settingsMembership(draft, row).direct &&
      !matched.some((r) => r.id !== rule.id && draft.selectedSources.has(r.id))
    );
  }).length;
}

type SuggestionGroup = {
  key: string;
  kind: "repository" | "folder" | "none";
  name: string;
  detail?: string | undefined;
  rows: SuggestionRow[];
};

const proposalTarget = (proposal: FolderProposal) =>
  proposal.kind === "repository"
    ? `repository:${proposal.repositoryKey}`
    : `folder:${personalFolderScopeId(proposal.folder)}`;

const sourceTarget = (source: SettingsSource) =>
  source.target?.kind === "repository"
    ? `repository:${source.target.repository.key}`
    : source.target?.kind === "folder"
      ? `folder:${personalFolderScopeId(source.target.folder)}`
      : undefined;

/** Suggestions require a rule that will still be selected at Save. */
export function suggestionsForSelectedRules(
  draft: ProjectSettingsDraft,
  rows: readonly SuggestionRow[]
): SuggestionRow[] {
  const targets = new Set(
    draft.sources
      .filter((source) => draft.selectedSources.has(source.id))
      .map(sourceTarget)
  );
  return rows.filter((row) => targets.has(proposalTarget(row.proposal)));
}

/** Suggestions, grouped by the rule of this Project they would join. */
export function suggestionGroups(
  draft: ProjectSettingsDraft,
  rows: readonly SuggestionRow[]
): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const row of rows) {
    const key = proposalTarget(row.proposal);
    const source = draft.sources.find((s) => sourceTarget(s) === key);
    const group: SuggestionGroup = groups.get(key) ?? {
      key,
      kind: row.proposal.kind === "repository" ? "repository" : "folder",
      name:
        source?.name ??
        row.proposal.directory ??
        (row.proposal.kind === "repository" ? "Git Anchor" : "Folder"),
      detail: source?.detail,
      rows: []
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
}

function ClientMark({ client }: { client?: SupportedAiClientDriverId }) {
  return (
    <span className={`v1-nav-client-mark ${client ?? ""}`} aria-hidden="true">
      {client ? <AiClientLogo id={client} /> : <MessageCircle />}
    </span>
  );
}

/** One Conversation (or Project) row: what it is, how it is (or would be)
 * connected, and a single action. A pending change tints the row and offers
 * Undo instead. Shared by Project settings and the Conversation dialogs. */
export function Row({
  title,
  mark,
  className,
  menuSlot = true,
  client,
  latestAt,
  now,
  detail,
  tag,
  locked = false,
  pending,
  action,
  menu,
  busy,
  onAction,
  onUndo
}: {
  title: string;
  /** Drawn in place of the AI Client logo, such as a Project's Kin. */
  mark?: ReactNode;
  /** Extra class for the row, such as one that dims it. */
  className?: string | undefined;
  /** Keep room for a menu so actions line up with rows that have one. */
  menuSlot?: boolean;
  client?: SupportedAiClientDriverId | undefined;
  latestAt?: string | undefined;
  now?: number;
  detail: string;
  /** A short note beside the detail, such as "+1 rule". */
  tag?: string | undefined;
  /** Kept in the Project even if its rules change. */
  locked?: boolean;
  /** What saving will do, when this row has a pending change. */
  pending?: string | undefined;
  action?: string | undefined;
  menu?: ReactNode;
  busy: boolean;
  onAction?: () => void;
  onUndo?: () => void;
}) {
  return (
    <div
      className={`v1-pm-choice-row v1-pm-conversation-row${pending ? " is-pending" : ""}${className ? ` ${className}` : ""}`}
    >
      {mark ?? <ClientMark {...(client ? { client } : {})} />}
      <span className="v1-pm-row-copy">
        <b title={title}>{title}</b>
        <small>
          {locked && !pending && (
            <Lock
              className="v1-pm-row-lock"
              aria-label="Kept if rules change"
            />
          )}
          {[
            pending ?? detail,
            ...(latestAt && now ? [conversationActivity(latestAt, now)] : [])
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
      {tag && !pending && <span className="v1-pm-row-tag">{tag}</span>}
      {pending && onUndo ? (
        <button
          type="button"
          className="v1-pm-row-text-action"
          aria-label={`Undo for ${title}`}
          disabled={busy}
          onClick={onUndo}
        >
          Undo
        </button>
      ) : (
        <>
          {!pending && action && onAction && (
            <button
              type="button"
              className="v1-pm-row-text-action"
              aria-label={`${action} ${title}`}
              disabled={busy}
              onClick={onAction}
            >
              {action}
            </button>
          )}
          {(!pending && menu) ||
            (menuSlot && (
              <span className="v1-pm-row-action-slot" aria-hidden />
            ))}
        </>
      )}
      {pending && onUndo && menuSlot && (
        <span className="v1-pm-row-action-slot" aria-hidden />
      )}
    </div>
  );
}

export function RowMenu({
  title,
  busy,
  children
}: {
  title: string;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <button
            type="button"
            className="v1-pm-row-action"
            aria-label={`More for ${title}`}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuPopup
        className="v1-app v1-project-ui v1-pm-menu"
        align="end"
      >
        {children}
      </DropdownMenuPopup>
    </DropdownMenu>
  );
}

/** A collapsible group of Conversations, closed until the User opens it. */
function Group({
  id,
  icon,
  name,
  count,
  detail,
  pending,
  open,
  onToggle,
  actions,
  children
}: {
  id: string;
  icon: ReactNode;
  name: string;
  /** Where the rule points, such as a path or Git remote. */
  detail?: string | undefined;
  count: string;
  pending?: string | undefined;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = `v1-pm-group-${id.replace(/[^\w-]/g, "_")}`;
  return (
    <section
      className={`v1-pm-group${pending ? " is-pending" : ""}`}
      aria-label={name}
    >
      <div className="v1-pm-group-head">
        <button
          type="button"
          className="v1-pm-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <ChevronRight className="v1-pm-group-chevron" aria-hidden />
          {icon}
          <b title={name}>{name}</b>
          {detail && detail !== name && (
            <span className="v1-pm-group-detail" title={detail}>
              {detail}
            </span>
          )}
          <small>{pending ?? count}</small>
        </button>
        {actions}
      </div>
      {open && (
        <div className="v1-pm-group-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

export function ConversationsPanel({
  draft,
  busy,
  query,
  onQuery,
  suggested,
  suggestionsLoading,
  accepted,
  onAccepted,
  rejected,
  onRejected,
  facts,
  now,
  onMembership,
  onRule
}: {
  draft: ProjectSettingsDraft;
  busy: boolean;
  query: string;
  onQuery: (query: string) => void;
  suggested: readonly SuggestionRow[];
  suggestionsLoading: boolean;
  accepted: ReadonlySet<string>;
  onAccepted: (accepted: ReadonlySet<string>) => void;
  /** Suggestions the User turned down; saving excludes them. */
  rejected: ReadonlySet<string>;
  onRejected: (rejected: ReadonlySet<string>) => void;
  facts: ConversationFacts;
  now: number;
  /** Stage a membership change; undefined puts the row back as it was. */
  onMembership: (sessionId: string, next: MembershipDraft | undefined) => void;
  /** Stage adding or removing a Folder or Git Anchor rule. */
  onRule: (sourceId: string, selected: boolean) => void;
}) {
  // Every group starts closed each time the page opens.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpenGroups((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const searching = query.trim().length > 0;
  const matches = (title: string) =>
    title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  // A search opens every group with a match and hides the rest.
  const isOpen = (key: string) => searching || openGroups.has(key);
  const approvalKey = (row: SuggestionRow) =>
    suggestionApprovalKey(draft.project.id, row);
  // A suggestion is added, excluded, or left alone.
  const choose = (rows: SuggestionRow[], choice?: "add" | "exclude") => {
    const add = new Set(accepted),
      exclude = new Set(rejected);
    for (const row of rows) {
      const key = approvalKey(row);
      add.delete(key);
      exclude.delete(key);
      if (choice === "add") add.add(key);
      if (choice === "exclude") exclude.add(key);
    }
    onAccepted(add);
    onRejected(exclude);
  };
  const fact = (sessionId: string) => facts.get(sessionId) ?? {};
  const groups = memberGroups(draft);
  const unusedRules = draft.sources.filter(
    (s) => isRule(s) && !s.inclusionId && !draft.selectedSources.has(s.id)
  );
  const folderDetails = folderPickerDetails(unusedRules);

  const memberRow = (row: SettingsConversation, rule?: SettingsSource) => {
    const membership = settingsMembership(draft, row);
    const rules = settingsMatchingSources(draft, row);
    const unresolved = unresolvedMembership(row.explanation);
    const leaving = rule && ruleState(draft, rule) === "removing";
    const stagedExclusion =
      draft.memberships[row.sessionId]?.included === false &&
      row.explanation.included &&
      row.explanation.reasons.some((reason) => reason.kind !== "session");
    const { client, latestAt } = fact(row.sessionId);
    return (
      <Row
        key={row.sessionId}
        title={row.title}
        client={client}
        latestAt={latestAt}
        now={now}
        busy={busy}
        detail={
          unresolved
            ? "Review sync conflict"
            : leaving
              ? membership.included
                ? "Stays through another rule"
                : "Leaves with this rule"
              : rule
                ? ""
                : "Added directly"
        }
        tag={
          !leaving && rules.length > 1
            ? `+${rules.length - 1} rule${rules.length > 2 ? "s" : ""}`
            : undefined
        }
        locked={membership.direct}
        pending={
          leaving
            ? stagedExclusion
              ? "Will be excluded"
              : undefined
            : membership.included
              ? membership.direct !== directMembership(row.explanation)
                ? membership.direct
                  ? "Will be kept if rules change"
                  : "Will follow the rules only"
                : undefined
              : rules.length > 0
                ? "Will be excluded"
                : "Will be removed"
        }
        {...(unresolved || leaving ? {} : { action: "Remove" })}
        onAction={() =>
          onMembership(row.sessionId, {
            included: false,
            direct: false,
            restore: false
          })
        }
        onUndo={() => onMembership(row.sessionId, undefined)}
        menu={
          !unresolved &&
          !leaving &&
          (rules.length > 0 || membership.direct) && (
            <RowMenu title={row.title} busy={busy}>
              <DropdownMenuCheckboxItem
                disabled={busy}
                checked={membership.direct}
                // With no rule to fall back on, turning it off takes the
                // Conversation out of the Project.
                onCheckedChange={(checked) =>
                  onMembership(
                    row.sessionId,
                    checked || rules.length > 0
                      ? { ...membership, direct: checked }
                      : { included: false, direct: false, restore: false }
                  )
                }
              >
                <span className="v1-pm-menu-check-label">
                  <Lock />
                  Keep if rules change
                </span>
              </DropdownMenuCheckboxItem>
            </RowMenu>
          )
        }
      />
    );
  };

  const excludedRow = (row: SettingsConversation) => {
    const membership = settingsMembership(draft, row);
    const unresolved = unresolvedMembership(row.explanation);
    const { client, latestAt } = fact(row.sessionId);
    return (
      <Row
        key={row.sessionId}
        title={row.title}
        client={client}
        latestAt={latestAt}
        now={now}
        busy={busy}
        detail={unresolved ? "Review sync conflict" : "Excluded by you"}
        pending={membership.restore ? "Will be added back" : undefined}
        {...(unresolved ? {} : { action: "Add back" })}
        onAction={() =>
          onMembership(row.sessionId, {
            included: true,
            direct: true,
            restore: true
          })
        }
        onUndo={() => onMembership(row.sessionId, undefined)}
      />
    );
  };

  const memberSection = groups.flatMap((group) => {
    const shownMembers = group.members.filter((c) => matches(c.title));
    const shownExcluded = group.excluded.filter((c) => matches(c.title));
    if (searching && shownMembers.length + shownExcluded.length === 0)
      return [];
    const rule = group.rule;
    const state = rule ? ruleState(draft, rule) : "saved";
    const included = group.members.filter(
      (c) => settingsMembership(draft, c).included
    ).length;
    const count = [
      ...(group.key === "excluded"
        ? []
        : [`${included} Conversation${included === 1 ? "" : "s"}`]),
      ...(group.excluded.length > 0
        ? [`${group.excluded.length} excluded`]
        : [])
    ].join(" · ");
    const name = rule
      ? rule.name
      : group.key === "direct"
        ? "Added directly"
        : "Excluded";
    const icon = rule ? (
      rule.kind === "repository" ? (
        <GitFork />
      ) : (
        <Folder />
      )
    ) : group.key === "direct" ? (
      <Hand />
    ) : (
      <EyeOff />
    );
    const leaving = rule ? leavingWith(draft, rule) : 0;
    return [
      <Group
        key={group.key}
        id={group.key}
        icon={icon}
        name={name}
        detail={rule?.detail}
        count={count}
        pending={
          state === "removing"
            ? `Will be removed · ${leaving} leave`
            : state === "adding"
              ? `Will be added · ${included}`
              : undefined
        }
        open={isOpen(group.key)}
        onToggle={() => toggle(group.key)}
        actions={
          rule &&
          (state === "saved" ? (
            <RowMenu title={name} busy={busy}>
              <DropdownMenuItem
                disabled={busy}
                onClick={() => onRule(rule.id, false)}
              >
                <Trash2 />
                <span className="v1-pm-menu-two-line">
                  Remove {ruleNoun(rule.kind)}
                  <small>
                    {leaving} leave
                    {included > leaving ? ` · ${included - leaving} stay` : ""}
                  </small>
                </span>
              </DropdownMenuItem>
            </RowMenu>
          ) : (
            <button
              type="button"
              className="v1-pm-row-text-action"
              aria-label={`Undo for ${name}`}
              disabled={busy}
              onClick={() => onRule(rule.id, state === "removing")}
            >
              Undo
            </button>
          ))
        }
      >
        {shownMembers
          // Kept Conversations first; by saved state, so rows stay put.
          .sort(
            (a, b) =>
              Number(directMembership(b.explanation)) -
              Number(directMembership(a.explanation))
          )
          .map((row) => memberRow(row, rule))}
        {shownExcluded.map(excludedRow)}
        {shownMembers.length + shownExcluded.length === 0 && (
          <p className="v1-pm-group-empty">No conversations yet</p>
        )}
      </Group>
    ];
  });

  const suggestionSection = suggestionGroups(draft, suggested).flatMap(
    (group) => {
      const shown = group.rows.filter((row) => matches(row.title));
      if (searching && shown.length === 0) return [];
      const key = `suggested:${group.key}`;
      const open = group.rows.filter((row) => !rejected.has(approvalKey(row)));
      const allAdded =
        open.length > 0 && open.every((row) => accepted.has(approvalKey(row)));
      return [
        <Group
          key={key}
          id={key}
          icon={group.kind === "repository" ? <GitFork /> : <Folder />}
          name={group.name}
          detail={group.detail}
          count={`${group.rows.length} Conversation${group.rows.length === 1 ? "" : "s"}`}
          open={isOpen(key)}
          onToggle={() => toggle(key)}
          actions={
            open.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                aria-label={
                  allAdded
                    ? `Undo adding ${group.name}`
                    : `Add ${open.length} from ${group.name}`
                }
                onClick={() => choose(open, allAdded ? undefined : "add")}
              >
                {allAdded ? "Undo" : `Add ${open.length}`}
              </Button>
            )
          }
        >
          {shown.map((row) => (
            <Row
              key={row.sessionId}
              title={row.title}
              client={row.client}
              latestAt={row.latestAt}
              now={now}
              busy={busy}
              detail={suggestionReason(row.proposal)}
              pending={
                accepted.has(approvalKey(row))
                  ? "Will be added"
                  : rejected.has(approvalKey(row))
                    ? "Will be excluded"
                    : undefined
              }
              action="Add"
              onAction={() => choose([row], "add")}
              onUndo={() => choose([row])}
              menu={
                <RowMenu title={row.title} busy={busy}>
                  <DropdownMenuItem
                    disabled={busy}
                    onClick={() => choose([row], "exclude")}
                  >
                    <EyeOff />
                    Not this one
                  </DropdownMenuItem>
                </RowMenu>
              }
            />
          ))}
        </Group>
      ];
    }
  );

  return (
    <>
      <div className="v1-pm-list-controls">
        <Input
          type="search"
          placeholder="Find a Conversation…"
          aria-label="Search Project Conversations"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="v1-pm-group-heading">
        <h3>Rules</h3>
        {unusedRules.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={<Button variant="ghost" size="xs" />}
            >
              <Plus />
              Add rule
            </DropdownMenuTrigger>
            <DropdownMenuPopup
              className="v1-app v1-project-ui v1-pm-menu v1-pm-rule-menu"
              align="end"
            >
              {(["repository", "folder"] as const).map((kind) => {
                const options = unusedRules.filter((s) => s.kind === kind);
                return (
                  options.length > 0 && (
                    <DropdownMenuGroup key={kind}>
                      <DropdownMenuLabel>
                        {kind === "repository" ? "Git Anchors" : "Folders"}
                      </DropdownMenuLabel>
                      {options.map((source) => (
                        <DropdownMenuItem
                          key={source.id}
                          disabled={busy}
                          onClick={() => onRule(source.id, true)}
                        >
                          {kind === "repository" ? <GitFork /> : <Folder />}
                          <span className="v1-pm-menu-two-line">
                            {source.name}
                            {source.target?.kind === "folder" ? (
                              <small>{folderDetails.get(source.id)}</small>
                            ) : null}
                            <small>{source.threads.length} Conversations</small>
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  )
                );
              })}
            </DropdownMenuPopup>
          </DropdownMenu>
        )}
      </div>
      <div className="v1-pm-groups">{memberSection}</div>
      {groups.length === 0 && (
        <div className="v1-pm-empty">
          <MessageCircle />
          No conversations yet
        </div>
      )}
      {(suggested.length > 0 || suggestionsLoading) && (
        <>
          <div className="v1-pm-group-heading">
            <h3>
              Suggested
              {suggested.length > 0 && (
                <CountCoin count={suggested.length} tone="silver" />
              )}
            </h3>
          </div>
          <div className="v1-pm-groups">{suggestionSection}</div>
          {suggested.length === 0 && (
            <div className="v1-pm-empty">
              <FolderSearch />
              Checking conversations…
            </div>
          )}
        </>
      )}
    </>
  );
}
