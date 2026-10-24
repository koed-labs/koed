import { useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Folder,
  Search,
  Users,
  X
} from "lucide-react";
import { SharingStore } from "./sharing-store.js";
import {
  sharingRows,
  sharingGroups,
  standaloneSharing,
  wordStartMatch,
  type SharingRow
} from "./sharing-view-model.js";
import "./hq-sharing.css";

type Action = { kind: "remove" | "cancel"; row: SharingRow };
const time = (value: string) => new Date(value).toLocaleString();
const age = (value: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60_000)
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

export function HqSharing({
  store,
  ownerId,
  profileKey,
  projectFilter,
  onClearProjectFilter,
  localConversations,
  onOpenConversation,
  onRequestAction,
  onReviewInvitation,
  onReviewLeave
}: {
  store: SharingStore;
  ownerId: string | null;
  profileKey: string | null;
  projectFilter?: { id: string; name: string; backendId: string } | null;
  onClearProjectFilter?: () => void;
  localConversations?: ReadonlyMap<string, string>;
  onOpenConversation?: (id: string) => void;
  onRequestAction?: (action: Action) => void;
  onReviewInvitation?: (
    id: string,
    backendId: string,
    decision: "accept" | "decline"
  ) => void;
  onReviewLeave?: (projectId: string, backendId: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.current,
    store.current
  );
  const [by, setBy] = useState<"person" | "project">("person");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState({ you: false, them: false });
  const [detail, setDetail] = useState<string | null>(null);
  const overview =
    snapshot.ownerId === ownerId && snapshot.profileKey === profileKey
      ? snapshot.overview
      : null;
  if (!overview)
    return (
      <main className="hq-sharing">
        <h1>Sharing</h1>
        <p role="status">
          {snapshot.error ??
            (snapshot.loading ? "Loading sharing…" : "Sharing is unavailable.")}
        </p>
        {snapshot.error ? (
          <button type="button" onClick={() => void store.refresh()}>
            Retry
          </button>
        ) : null}
      </main>
    );
  const rows = sharingRows(overview);
  const own = rows.filter(
    (row) =>
      row.ownedByMe &&
      !(row.projectOwnerId && row.personId === row.projectOwnerId) &&
      (!projectFilter ||
        (row.projectId === projectFilter.id &&
          row.backendId === projectFilter.backendId))
  );
  const standalone = standaloneSharing(overview);
  const standaloneAccess = standalone.flatMap(({ backendId, access }) =>
    access.map((item) => ({ backendId, item }))
  );
  const standaloneInvites = standalone.flatMap(({ backendId, invitations }) =>
    invitations.map((item) => ({ backendId, item }))
  );
  const incoming = overview.backends.flatMap((backend) =>
    backend.status === "available"
      ? backend.incomingInvitations.map((item) => ({
          backendId: backend.backendId,
          item
        }))
      : []
  );
  const theirs = overview.backends.flatMap((backend) =>
    backend.status === "available"
      ? backend.data.projects
          .filter(
            (project) => !project.ownedByMe && project.joinedByMe === true
          )
          .map((project) => ({ backendId: backend.backendId, project }))
      : []
  );
  const unavailable = overview.backends.filter(
    (backend) => backend.status === "unavailable"
  );
  const partial = unavailable.length > 0;
  const people = new Set(
    own.map((row) => `${row.backendId}:${row.personId ?? row.personName}`)
  );
  const projects = new Set(
    own.map((row) => `${row.backendId}:${row.projectId}`)
  );
  const flagged = own.filter(
    (row) => row.origin.actorKind === "agent_on_behalf"
  );
  const flaggedAgents = [
    ...new Set(
      flagged.map((row) => row.origin.agentDisplayName ?? "your Agent")
    )
  ];
  const fresh = own
    .filter((row) => Date.now() - Date.parse(row.since) <= 86_400_000)
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  const q = query.trim();
  const ownGroups = sharingGroups(own, by);
  const matchedGroups = ownGroups.filter(
    (group) =>
      !q ||
      wordStartMatch(group.name, q) ||
      own.some((row) =>
        by === "person"
          ? `${row.backendId}:${row.personId ?? row.personName}` ===
              group.key && wordStartMatch(row.projectName, q)
          : `${row.backendId}:${row.projectId}` === group.key &&
            wordStartMatch(row.personName, q)
      )
  );
  const matchedIncoming = projectFilter
    ? []
    : incoming.filter(
        ({ item }) =>
          !q ||
          [
            item.inviter.displayName ?? "",
            item.project?.name ?? item.workspace.name
          ].some((value) => wordStartMatch(value, q))
      );
  const matchedTheirs = projectFilter
    ? []
    : theirs.filter(
        ({ project }) =>
          !q ||
          [project.name, project.owner.displayName].some((value) =>
            wordStartMatch(value, q)
          )
      );
  const matchedStandaloneAccess = projectFilter
    ? []
    : standaloneAccess.filter(
        ({ item }) =>
          !q ||
          [
            item.person.displayName,
            item.workspaceName ?? "",
            item.teamName ?? ""
          ].some((value) => wordStartMatch(value, q))
      );
  const matchedStandaloneInvites = projectFilter
    ? []
    : standaloneInvites.filter(
        ({ item }) =>
          !q ||
          [
            item.person.displayName,
            item.workspaceName ?? "",
            item.teamName ?? ""
          ].some((value) => wordStartMatch(value, q))
      );
  const showFilter =
    ownGroups.length +
      incoming.length +
      theirs.length +
      standaloneAccess.length +
      standaloneInvites.length >
      8 || Boolean(q);
  const limit = (section: "you" | "them") => (expanded[section] ? Infinity : 6);
  const action = (row: SharingRow) =>
    row.canCancel || row.canRemove ? (
      <button
        type="button"
        onClick={() =>
          onRequestAction?.({ kind: row.canCancel ? "cancel" : "remove", row })
        }
        disabled={!onRequestAction}
        title={
          !onRequestAction
            ? "Access changes are not available here yet"
            : undefined
        }
      >
        {row.canCancel ? "Cancel invitation" : "Remove access"}
      </button>
    ) : null;
  const quantity = (count: number | undefined, one: string, many: string) =>
    count === undefined
      ? `an unknown number of ${many}`
      : `${count} ${count === 1 ? one : many}`;
  const detailView = (row: SharingRow) => {
    const originConversationId =
      row.origin.source.kind === "conversation"
        ? row.origin.source.conversationId
        : null;
    return (
      <div className="hq-sharing__detail">
        <p>
          {row.status === "invited"
            ? `Once ${row.personName} accepts, they can see`
            : `${row.personName} can see`}{" "}
          {row.projectName}’s HQ,{" "}
          {quantity(row.contentCounts?.sources, "source", "sources")},{" "}
          {quantity(row.contentCounts?.toDos, "to-do", "to-dos")},{" "}
          {quantity(
            row.contentCounts?.chatSummaries,
            "chat (summary)",
            "chats (summaries)"
          )}
          , and what the Project remembers (
          {quantity(row.contentCounts?.sharedMemoryItems, "thing", "things")}).
          Your HQ chat and Me-scoped memory are not shared by this Project.
        </p>
        <p>
          How:{" "}
          {row.origin.source.kind === "not_recorded" ? (
            "not recorded"
          ) : (
            <>
              {row.origin.actorKind === "agent_on_behalf"
                ? `${row.origin.agentDisplayName ?? "Your Agent"} sent the invitation`
                : "Invitation sent"}{" "}
              {age(row.since)}
              {row.origin.accessMode === "full_access"
                ? ", while Full access was on"
                : ""}
              {originConversationId &&
              localConversations?.has(originConversationId) &&
              onOpenConversation ? (
                <>
                  {" "}
                  from your chat “{localConversations.get(originConversationId)}
                  ”.{" "}
                  <button
                    type="button"
                    onClick={() => onOpenConversation(originConversationId)}
                  >
                    Open that chat
                  </button>
                </>
              ) : (
                "."
              )}
            </>
          )}
        </p>
      </div>
    );
  };
  const card = (
    group: { key: string; name: string },
    groupRows: SharingRow[]
  ) => (
    <article
      className={`hq-sharing__card${groupRows.some((row) => row.origin.actorKind === "agent_on_behalf") ? " hq-sharing__card--agent" : ""}`}
      key={group.key}
    >
      <div className="hq-sharing__card-head">
        <span className="hq-sharing__avatar" aria-hidden="true">
          {by === "person" ? group.name.slice(0, 1) : <Folder size={16} />}
        </span>
        <h3>{group.name}</h3>
      </div>
      <p>
        {by === "person"
          ? `Sees ${[...new Set(groupRows.map((row) => row.projectName))].join(", ")}`
          : `${groupRows.length} ${groupRows.length === 1 ? "person" : "people"} · ${groupRows[0]?.groupName}`}
      </p>
      {groupRows.map((row) => (
        <div className="hq-sharing__row" key={row.key}>
          <div>
            <strong>
              {by === "person" ? row.projectName : row.personName}
            </strong>
            <small>
              {row.status === "invited"
                ? "Invited · not accepted yet"
                : row.access === "view"
                  ? "Can view"
                  : "Can edit"}{" "}
              ·{" "}
              {row.how === "through_group"
                ? "Through group"
                : row.how === "direct"
                  ? "Direct access"
                  : "Invitation"}{" "}
              · {time(row.since)}
            </small>
            {row.origin.actorKind === "agent_on_behalf" ? (
              <small className="hq-sharing__agent-flag">
                <AlertTriangle size={12} aria-hidden="true" />
                {row.origin.agentDisplayName ?? "Your Agent"} shared this{" "}
                {age(row.since)}
                {row.origin.accessMode === "full_access"
                  ? ", while Full access was on"
                  : row.origin.accessMode === "ask_first"
                    ? ", with Ask first"
                    : ""}
              </small>
            ) : null}
          </div>
          {action(row)}
        </div>
      ))}
    </article>
  );
  return (
    <main className="hq-sharing" aria-label="Sharing">
      <header className="hq-sharing__header">
        <div>
          <h1>Sharing</h1>
          <p>Who sees your work, and how it got shared.</p>
          <button
            type="button"
            onClick={() =>
              document.getElementById("hq-sharing-help")?.scrollIntoView()
            }
          >
            How sharing works
          </button>
        </div>
        <div className="hq-sharing__seg" role="group" aria-label="Group by">
          <button
            type="button"
            aria-pressed={by === "person"}
            onClick={() => {
              setBy("person");
              setExpanded((current) => ({ ...current, you: false }));
            }}
          >
            By person
          </button>
          <button
            type="button"
            aria-pressed={by === "project"}
            onClick={() => {
              setBy("project");
              setExpanded((current) => ({ ...current, you: false }));
            }}
          >
            By project
          </button>
        </div>
      </header>
      <div className="hq-sharing__stats">
        <span>
          <Users size={15} />
          <b>
            {partial ? "at least " : ""}
            {people.size}
          </b>{" "}
          people see your work
        </span>
        <span>
          <Folder size={15} />
          <b>
            {partial ? "at least " : ""}
            {projects.size}
          </b>{" "}
          projects shared
        </span>
        {flagged.length ? (
          <span className="hq-sharing__warn">
            <AlertTriangle size={15} />
            <b>
              {partial ? "at least " : ""}
              {flagged.length}
            </b>{" "}
            shared by{" "}
            {flaggedAgents.length === 1 ? flaggedAgents[0] : "your Agents"}:
            worth a check
          </span>
        ) : null}
      </div>
      {unavailable.map((backend) => (
        <p
          className="hq-sharing__unavailable"
          role="status"
          key={backend.backendId}
        >
          Couldn’t reach {backend.backendId}; its shares aren’t shown.
        </p>
      ))}
      {projectFilter ? (
        <div className="hq-sharing__chip">
          {projectFilter.name}
          <button
            type="button"
            aria-label="Show everything"
            onClick={onClearProjectFilter}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {!projectFilter ? (
        <section>
          <h2>Recently shared</h2>
          {fresh.length ? (
            <div className="hq-sharing__list">
              {fresh.map((row) => (
                <article className="hq-sharing__card" key={row.key}>
                  <div className="hq-sharing__row">
                    <button
                      type="button"
                      className="hq-sharing__detail-toggle"
                      aria-expanded={detail === row.key}
                      onClick={() =>
                        setDetail(detail === row.key ? null : row.key)
                      }
                    >
                      <ChevronDown size={15} />
                      <span
                        className="hq-sharing__avatar hq-sharing__avatar--small"
                        aria-hidden="true"
                      >
                        {row.personName.slice(0, 1)}
                      </span>
                      <span>
                        {row.origin.actorKind === "agent_on_behalf"
                          ? (row.origin.agentDisplayName ?? "Your Agent")
                          : "You"}{" "}
                        {row.status === "invited" ? "invited" : "shared with"}{" "}
                        {row.personName} · {row.projectName}
                        <small>
                          {age(row.since)}
                          {row.status === "invited"
                            ? " · not accepted yet"
                            : ""}
                        </small>
                      </span>
                    </button>
                    {action(row)}
                  </div>
                  {detail === row.key ? detailView(row) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="hq-sharing__empty">
              <Clock3 size={15} />
              Nothing shared in the last 24 hours.
            </p>
          )}
        </section>
      ) : null}
      {showFilter ? (
        <label className="hq-sharing__filter">
          <Search size={17} />
          <input
            type="search"
            aria-label="Filter by person or project"
            placeholder="Filter by person or project"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
          {q ? (
            <button
              type="button"
              aria-label="Clear the filter"
              onClick={() => setQuery("")}
            >
              <X size={15} />
            </button>
          ) : null}
        </label>
      ) : null}
      <section>
        <h2>
          You share <small>{matchedGroups.length}</small>
        </h2>
        {matchedGroups.length ? (
          <div className="hq-sharing__list">
            {matchedGroups.slice(0, limit("you")).map((group) =>
              card(
                group,
                own.filter((row) =>
                  by === "person"
                    ? `${row.backendId}:${row.personId ?? row.personName}` ===
                      group.key
                    : `${row.backendId}:${row.projectId}` === group.key
                )
              )
            )}
            {matchedGroups.length > 6 ? (
              <button
                type="button"
                className="hq-sharing__more"
                onClick={() =>
                  setExpanded((current) => ({ ...current, you: !current.you }))
                }
              >
                {expanded.you
                  ? "Show less"
                  : `Show ${matchedGroups.length - 6} more`}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="hq-sharing__empty">
            {q
              ? `Nothing you share matches “${q}”.`
              : "Nothing of yours is shared."}
          </p>
        )}
      </section>
      {!projectFilter &&
      (matchedStandaloneAccess.length || matchedStandaloneInvites.length) ? (
        <section>
          <h2>Workspace and Team access</h2>
          <div className="hq-sharing__list">
            {matchedStandaloneAccess.map(({ backendId, item }) => (
              <article
                className="hq-sharing__card"
                key={`${backendId}:${item.teamWorkspaceId}:${item.person.id ?? item.person.displayName}`}
              >
                <h3>{item.person.displayName}</h3>
                <p>
                  {item.access === "view" ? "Can view" : "Can edit"} · Direct
                  access to {item.workspaceName ?? "this Workspace"} in{" "}
                  {item.teamName ?? "this Team"}. This does not by itself grant
                  access to a Project.
                </p>
                {item.canRemove ? (
                  <button
                    type="button"
                    disabled
                    title="Access removal is pending capability"
                  >
                    Remove access
                  </button>
                ) : null}
              </article>
            ))}
            {matchedStandaloneInvites.map(({ backendId, item }) => (
              <article
                className="hq-sharing__card"
                key={`${backendId}:${item.id}`}
              >
                <h3>{item.person.displayName}</h3>
                <p>
                  Invited to {item.teamName ?? "a Team"}
                  {item.workspaceName ? ` · ${item.workspaceName}` : ""} · not
                  accepted yet
                </p>
                {item.canCancel ? (
                  <button
                    type="button"
                    disabled
                    title="Invitation cancellation is pending capability"
                  >
                    Cancel invitation
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {!projectFilter ? (
        <section>
          <h2>
            Shared with you{" "}
            <small>{matchedIncoming.length + matchedTheirs.length}</small>
          </h2>
          {matchedIncoming.length + matchedTheirs.length ? (
            <div className="hq-sharing__list">
              {[
                ...matchedIncoming.map(({ backendId, item }) => (
                  <article
                    className="hq-sharing__card"
                    key={`${backendId}:${item.id}`}
                  >
                    <h3>
                      {item.inviter.displayName ?? "Someone"} invited you to{" "}
                      {item.project?.name ?? item.workspace.name}
                    </h3>
                    <p>
                      Can {item.access === "view" ? "view" : "edit"} ·{" "}
                      {item.team.name}
                    </p>
                    <div className="hq-sharing__actions">
                      <button
                        type="button"
                        onClick={() =>
                          onReviewInvitation?.(item.id, backendId, "accept")
                        }
                        disabled={!onReviewInvitation}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onReviewInvitation?.(item.id, backendId, "decline")
                        }
                        disabled={!onReviewInvitation}
                      >
                        Decline
                      </button>
                    </div>
                  </article>
                )),
                ...matchedTheirs.map(({ backendId, project }) => (
                  <article
                    className="hq-sharing__card"
                    key={`${backendId}:${project.id}`}
                  >
                    <h3>{project.name}</h3>
                    <p>
                      {project.owner.displayName}’s Project ·{" "}
                      {project.group.name}
                    </p>
                    <button
                      type="button"
                      onClick={() => onReviewLeave?.(project.id, backendId)}
                      disabled={!onReviewLeave}
                    >
                      Leave
                    </button>
                  </article>
                ))
              ].slice(0, limit("them"))}
              {matchedIncoming.length + matchedTheirs.length > 6 ? (
                <button
                  type="button"
                  className="hq-sharing__more"
                  onClick={() =>
                    setExpanded((current) => ({
                      ...current,
                      them: !current.them
                    }))
                  }
                >
                  {expanded.them
                    ? "Show less"
                    : `Show ${matchedIncoming.length + matchedTheirs.length - 6} more`}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="hq-sharing__empty">
              {q
                ? `Nothing shared with you matches “${q}”.`
                : "Nothing is shared with you."}
            </p>
          )}
        </section>
      ) : null}
      <section id="hq-sharing-help">
        <h2>How sharing works</h2>
        <p>
          Project access is granted through Team membership and Project
          membership. Your HQ chat and Me-scoped memory are not shared by a
          Project. Eligible Curated Memory needs a separate review.
        </p>
      </section>
    </main>
  );
}
