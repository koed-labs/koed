import type { ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuTrigger,
  Input,
  Tabs,
  TabsList,
  TabsTab
} from "@koed-labs/ui";
import { Ellipsis, EyeOff, Lock, MessageCircle } from "lucide-react";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
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
  type SettingsConversation
} from "./project-settings-model.js";
import { suggestionApprovalKey } from "./folder-hint-suggestion.js";
import { suggestionReason } from "./proposal-text.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";

export type ConversationFilter = "in" | "suggested" | "excluded";
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
  for (const row of draft.conversations) {
    if (!draft.memberships[row.sessionId]) continue;
    const now = settingsMembership(draft, row).included;
    const before = inProject(draft, row);
    if (now && !before) add += 1;
    if (!now && before) remove += 1;
  }
  return { add, remove };
}

function ClientMark({ client }: { client?: SupportedAiClientDriverId }) {
  return (
    <span className={`v1-nav-client-mark ${client ?? ""}`} aria-hidden="true">
      {client ? <AiClientLogo id={client} /> : <MessageCircle />}
    </span>
  );
}

/** One Conversation row: what it is, how it is (or would be) connected, and a
 * single action. A pending change tints the row and offers Undo instead. */
function Row({
  title,
  client,
  latestAt,
  now,
  detail,
  locked = false,
  pending,
  action,
  menu,
  busy,
  onAction,
  onUndo
}: {
  title: string;
  client?: SupportedAiClientDriverId | undefined;
  latestAt?: string | undefined;
  now: number;
  detail: string;
  /** Kept in the Project even if its rules change. */
  locked?: boolean;
  /** What saving will do, when this row has a pending change. */
  pending?: string | undefined;
  action?: string | undefined;
  menu?: ReactNode;
  busy: boolean;
  onAction?: () => void;
  onUndo: () => void;
}) {
  return (
    <div
      className={`v1-pm-choice-row v1-pm-conversation-row${pending ? " is-pending" : ""}`}
    >
      <ClientMark {...(client ? { client } : {})} />
      <span className="v1-pm-row-copy">
        <b title={title}>{title}</b>
        <small>
          {locked && !pending && (
            <Lock
              className="v1-pm-row-lock"
              aria-label="Kept if rules change"
            />
          )}
          {pending ?? detail}
          {latestAt ? ` · ${conversationActivity(latestAt, now)}` : ""}
        </small>
      </span>
      {pending ? (
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
          {action && onAction && (
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
          {menu || <span className="v1-pm-row-action-slot" aria-hidden />}
        </>
      )}
      {pending && <span className="v1-pm-row-action-slot" aria-hidden />}
    </div>
  );
}

function RowMenu({
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

export function ConversationsPanel({
  draft,
  busy,
  query,
  onQuery,
  filter,
  onFilter,
  suggested,
  suggestionsLoading,
  accepted,
  onAccepted,
  rejected,
  onRejected,
  facts,
  now,
  onMembership
}: {
  draft: ProjectSettingsDraft;
  busy: boolean;
  query: string;
  onQuery: (query: string) => void;
  filter: ConversationFilter;
  onFilter: (filter: ConversationFilter) => void;
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
}) {
  const matches = (title: string) =>
    title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const members = draft.conversations.filter((c) => inProject(draft, c));
  const excluded = draft.conversations.filter((c) =>
    excludedMembership(c.explanation)
  );
  const open = suggested.filter((row) => !rejected.has(row.sessionId));
  const approvalKey = (row: SuggestionRow) =>
    suggestionApprovalKey(draft.project.id, row);
  const allAdded = open.every((row) => accepted.has(approvalKey(row)));
  // A suggestion is added, excluded, or left alone.
  const choose = (row: SuggestionRow, choice?: "add" | "exclude") => {
    const key = approvalKey(row);
    const add = new Set(accepted),
      exclude = new Set(rejected);
    add.delete(key);
    exclude.delete(row.sessionId);
    if (choice === "add") add.add(key);
    if (choice === "exclude") exclude.add(row.sessionId);
    onAccepted(add);
    onRejected(exclude);
  };
  const fact = (sessionId: string) => facts.get(sessionId) ?? {};
  const empty = (text: string) => (
    <div className="v1-pm-empty">
      <MessageCircle />
      {text}
    </div>
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
      <div className="v1-pm-conversation-toolbar">
        <Tabs
          value={filter}
          onValueChange={(value) => onFilter(value as ConversationFilter)}
          className="v1-pm-conversation-filter"
        >
          <TabsList>
            <TabsTab value="in">
              In Project
              <CountCoin count={members.length} tone="gold" />
            </TabsTab>
            <TabsTab value="suggested">
              Suggested
              {suggested.length > 0 && (
                <CountCoin count={suggested.length} tone="silver" />
              )}
            </TabsTab>
            <TabsTab value="excluded">
              Excluded <small>{excluded.length}</small>
            </TabsTab>
          </TabsList>
        </Tabs>
        {filter === "suggested" && open.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() =>
              onAccepted(allAdded ? new Set() : new Set(open.map(approvalKey)))
            }
          >
            {allAdded ? "Undo all" : `Add all ${open.length}`}
          </Button>
        )}
      </div>
      {filter === "in" && (
        <>
          <div className="v1-pm-list v1-pm-conversation-list">
            {members
              .filter((c) => matches(c.title))
              // Locked Conversations first; by saved state, so rows stay put
              // while editing.
              .sort(
                (a, b) =>
                  Number(directMembership(b.explanation)) -
                  Number(directMembership(a.explanation))
              )
              .map((row) => {
                const membership = settingsMembership(draft, row);
                const rules = settingsMatchingSources(draft, row);
                const unresolved = unresolvedMembership(row.explanation);
                // The padlock shows a kept Conversation; the text says how it
                // is connected.
                const how =
                  rules.length > 0
                    ? rules
                        .map((r) =>
                          r.kind === "folder" ? "Folder" : "Git Anchor"
                        )
                        .join(" · ")
                    : "Added by you";
                const { client, latestAt } = fact(row.sessionId);
                return (
                  <Row
                    key={row.sessionId}
                    title={row.title}
                    client={client}
                    latestAt={latestAt}
                    now={now}
                    busy={busy}
                    detail={unresolved ? "Review sync conflict" : how}
                    locked={membership.direct}
                    pending={
                      membership.included
                        ? membership.direct !==
                          directMembership(row.explanation)
                          ? membership.direct
                            ? "Will be kept if rules change"
                            : "Will follow the rules only"
                          : undefined
                        : rules.length > 0
                          ? "Will be excluded"
                          : "Will be removed"
                    }
                    {...(unresolved ? {} : { action: "Remove" })}
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
                      (rules.length > 0 || membership.direct) && (
                        <RowMenu title={row.title} busy={busy}>
                          <DropdownMenuCheckboxItem
                            disabled={busy}
                            checked={membership.direct}
                            // With no rule to fall back on, turning it off
                            // takes the Conversation out of the Project.
                            onCheckedChange={(checked) =>
                              onMembership(
                                row.sessionId,
                                checked || rules.length > 0
                                  ? { ...membership, direct: checked }
                                  : {
                                      included: false,
                                      direct: false,
                                      restore: false
                                    }
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
              })}
          </div>
          {members.length === 0 && empty("No conversations yet")}
        </>
      )}
      {filter === "suggested" && (
        <>
          <div className="v1-pm-list v1-pm-conversation-list">
            {suggested
              .filter((row) => matches(row.title))
              .map((row) => (
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
                      : rejected.has(row.sessionId)
                        ? "Will be excluded"
                        : undefined
                  }
                  action="Add"
                  onAction={() => choose(row, "add")}
                  onUndo={() => choose(row)}
                  menu={
                    <RowMenu title={row.title} busy={busy}>
                      <DropdownMenuItem
                        disabled={busy}
                        onClick={() => choose(row, "exclude")}
                      >
                        <EyeOff />
                        Not this one
                      </DropdownMenuItem>
                    </RowMenu>
                  }
                />
              ))}
          </div>
          {suggested.length === 0 &&
            empty(
              suggestionsLoading
                ? "Checking conversations…"
                : "No suggestions right now"
            )}
        </>
      )}
      {filter === "excluded" && (
        <>
          <div className="v1-pm-list v1-pm-conversation-list">
            {excluded
              .filter((c) => matches(c.title))
              .map((row) => {
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
                    detail={
                      unresolved ? "Review sync conflict" : "Excluded by you"
                    }
                    pending={
                      membership.restore ? "Will be added back" : undefined
                    }
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
              })}
          </div>
          {excluded.length === 0 && empty("No excluded conversations")}
        </>
      )}
    </>
  );
}
