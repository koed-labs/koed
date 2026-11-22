import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, DialogFooter, Input } from "@koed-labs/ui";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Folder,
  GitFork,
  Laptop,
  MessageCircle,
  RefreshCw,
  Smile,
  Settings2
} from "lucide-react";
import type { PersonalProjectBatchInput } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import { ProjectSyncDetails } from "../../views/personal/ProjectSyncDetails.js";
import { ProjectChoice, ProjectError, ProjectPopup } from "./controls.js";
import {
  activeNamedProjects,
  excludedMembership
} from "./conversation-organization.js";
import {
  loadProjectSettings,
  settingsChanges,
  settingsMembership,
  selectSettingsSource,
  type ProjectSettingsDraft
} from "./project-settings-model.js";
import { projectErrorMessage } from "./use-organization-review.js";

import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { SuggestionCoin } from "./ProjectCoins.js";
import {
  ConversationsPanel,
  membershipSummary,
  type ConversationFilter
} from "./ConversationsPanel.js";
import { suggestionApprovalKey } from "./folder-hint-suggestion.js";
import { clientOf, type SuggestionRow } from "./use-folder-suggestions.js";
import type { SupportedAiClientDriverId } from "@koed-labs/shared/ai-client-contract";
import { AgentLookPicker } from "../pixelkin/AgentLookPicker.js";

const pages = [
  { id: "general", name: "General", Icon: Settings2 },
  { id: "kin", name: "Kin", Icon: Smile },
  { id: "sources", name: "Sources", Icon: GitFork },
  { id: "conversations", name: "Conversations", Icon: MessageCircle },
  { id: "sync", name: "Sync", Icon: RefreshCw }
] as const;
export type ProjectSettingsPage = (typeof pages)[number]["id"];
export type { ConversationFilter };

export function ProjectSettingsDialog({
  api,
  store,
  projects,
  projectId,
  page = "general",
  filter: initialFilter = "in",
  suggestions,
  onClose,
  onSave,
  onDelete
}: {
  api: PersonalDesktopApi;
  store: PersonalMemoryStore;
  projects: readonly DesktopProject[];
  projectId: string;
  page?: ProjectSettingsPage;
  /** Which Conversations to list first on the Conversations page. */
  filter?: ConversationFilter;
  /** Conversations suggested in the background, for every Project. */
  suggestions?: { rows: readonly SuggestionRow[]; loading: boolean };
  onClose: () => void;
  /** Saves the Project's changes (turned-down suggestions are excluded), then
   * adds the accepted suggestions. */
  onSave: (
    project: DesktopProject,
    changes: PersonalProjectBatchInput["changes"],
    accepted: SuggestionRow[],
    rejected: SuggestionRow[]
  ) => Promise<void>;
  onDelete: (project: DesktopProject) => Promise<void>;
}) {
  const [initialProjects] = useState(projects);
  const [active, setActive] = useState(projectId);
  const [panel, setPanel] = useState<ProjectSettingsPage>(page);
  const [draft, setDraft] = useState<ProjectSettingsDraft>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>(initialFilter);
  // Approvals bind the reviewed candidate to this destination Project.
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  // Suggested Conversations turned down; saving excludes them.
  const [rejected, setRejected] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<"delete" | "discard" | null>(
    null
  );
  const [nextProject, setNextProject] = useState<string>();
  const [syncOpen, setSyncOpen] = useState(false);
  const named = activeNamedProjects(initialProjects);
  useEffect(() => {
    let current = true;
    setDraft(undefined);
    setError("");
    const project = initialProjects.find((p) => p.id === active);
    if (!project) {
      setError("This Project is no longer available.");
      return;
    }
    void loadProjectSettings(api, project, initialProjects)
      .then((value) => {
        if (current) setDraft(value);
      })
      .catch((cause) => {
        if (current) setError(projectErrorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [active, api, initialProjects]);
  const activeName = initialProjects.find((p) => p.id === active)?.name;
  // Suggestions for this Project. A Conversation already in it, or excluded
  // from it, never is.
  const suggested = useMemo(() => {
    const excluded = new Set(
      (draft?.conversations ?? [])
        .filter(
          (c) => c.explanation.included || excludedMembership(c.explanation)
        )
        .map((c) => c.sessionId)
    );
    return (suggestions?.rows ?? []).filter(
      (row) =>
        !!activeName &&
        row.proposal.projects.includes(activeName) &&
        !excluded.has(row.sessionId)
    );
  }, [suggestions?.rows, activeName, draft?.conversations]);
  const validApprovals = new Set<string>();
  const acceptedRows = suggested.filter((row) => {
    const key = suggestionApprovalKey(active, row);
    if (!accepted.has(key)) return false;
    validApprovals.add(key);
    return true;
  });
  // Drop stale approvals so a later refresh cannot revive them.
  if (validApprovals.size !== accepted.size) setAccepted(validApprovals);
  const rejectedRows = suggested.filter((row) => rejected.has(row.sessionId));
  const changes = draft ? settingsChanges(draft) : [];
  const dirty =
    changes.length > 0 || acceptedRows.length > 0 || rejectedRows.length > 0;
  // "1 to add · 1 to remove", plus any other edits on the other pages.
  const footerSummary = (() => {
    if (!draft) return "";
    const { add, remove } = membershipSummary(draft, acceptedRows.length);
    const membershipActions = new Set([
      "add_session",
      "remove_inclusion",
      "exclude_session",
      "add_back"
    ]);
    const parts = [
      ...(add > 0 ? [`${add} to add`] : []),
      ...(remove > 0 ? [`${remove} to remove`] : []),
      ...(rejectedRows.length > 0 ? [`${rejectedRows.length} to exclude`] : []),
      ...(changes.some((c) => !membershipActions.has(c.action)) ||
      (add === 0 && remove === 0 && rejectedRows.length === 0)
        ? ["Unsaved changes"]
        : [])
    ];
    return parts.join(" · ");
  })();
  const editError =
    draft?.inspectionError ??
    (draft?.sync?.catalog && draft.sync.catalog.state !== "available"
      ? "Review Project sync before making changes."
      : undefined);
  const close = () => {
    setNextProject(undefined);
    if (dirty) setConfirmation("discard");
    else onClose();
  };
  const switchProject = (id: string) => {
    if (dirty) {
      setNextProject(id);
      setConfirmation("discard");
    } else {
      setActive(id);
      setPanel("general");
      setQuery("");
      setFilter("in");
      setAccepted(new Set());
      setRejected(new Set());
    }
  };
  const mutate = (
    update: (draft: ProjectSettingsDraft) => ProjectSettingsDraft
  ) => setDraft((old) => (old ? update(old) : old));
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(projectErrorMessage(cause));
      setConfirmation(null);
    } finally {
      setBusy(false);
    }
  };
  const [now] = useState(Date.now);
  // Client and latest activity per Conversation, for the row's mark and age.
  const facts = useMemo(() => {
    const map = new Map<
      string,
      { client?: SupportedAiClientDriverId; latestAt?: string }
    >();
    for (const project of projects)
      for (const thread of project.threads)
        if (thread.sessionId && !map.has(thread.sessionId)) {
          const client = clientOf(thread.sourceAiClient);
          map.set(thread.sessionId, {
            ...(client ? { client } : {}),
            ...(thread.latestAt ? { latestAt: thread.latestAt } : {})
          });
        }
    return map;
  }, [projects]);
  const syncEntities = draft?.sync
    ? [
        ...(draft.sync.catalog ? [draft.sync.catalog] : []),
        ...draft.sync.memberships
      ]
    : [];
  const conflict = syncEntities.some((e) => e.state === "conflict");
  const pending = syncEntities.some(
    (e) => e.state === "pending" || (e.source && !e.source.ready)
  );
  const devices = [
    ...new Set(
      syncEntities.flatMap((e) => e.heads.map((h) => h.authorDeviceId))
    )
  ];
  return (
    <ProjectPopup title="Project settings" settings busy={busy} onClose={close}>
      <nav
        className="v1-pm-settings-nav"
        aria-label="Project settings sections"
      >
        <span className="v1-pm-nav-title">Project settings</span>
        <ProjectChoice
          label="Select Project"
          value={active}
          options={named.map((p) => ({
            value: p.id,
            label: p.id === active ? draft?.name || p.name : p.name
          }))}
          onChange={switchProject}
          disabled={busy}
        />
        <div className="v1-pm-settings-links">
          {pages.map(({ id, name, Icon }) => (
            <Button
              key={id}
              variant="ghost"
              className="v1-pm-nav-link"
              aria-current={panel === id ? "page" : undefined}
              onClick={() => {
                setPanel(id);
                setQuery("");
              }}
            >
              <Icon />
              {name}
              {id === "conversations" && suggested.length > 0 && (
                <span className="v1-pm-nav-coin">
                  <SuggestionCoin count={suggested.length} />
                </span>
              )}
              {id === "sync" && (conflict || pending) && (
                <span className="v1-pm-review-dot" />
              )}
            </Button>
          ))}
        </div>
      </nav>
      <div className="v1-pm-settings-detail">
        <header className="v1-pm-page-heading">
          <h2>{pages.find((p) => p.id === panel)?.name}</h2>
        </header>
        <div className="v1-pm-settings-body">
          {!draft && !error && <p role="status">Loading…</p>}
          <ProjectError error={error} />
          {panel !== "sync" && <ProjectError error={editError} />}
          {draft && !editError && panel === "kin" && (
            <fieldset
              disabled={busy}
              className="v1-pm-kin-builder"
              aria-label="Project Kin"
            >
              <div
                className="v1-pm-kin-preview"
                role="img"
                aria-label="Kin preview"
              >
                <div className="v1-kin-spot" aria-hidden="true" />
                <Pixelkin look={draft.look} size={142} hopOnChange />
              </div>
              <AgentLookPicker
                look={draft.look}
                disabled={busy}
                onChange={(look) => mutate((old) => ({ ...old, look }))}
              />
            </fieldset>
          )}
          {draft && !editError && panel === "general" && (
            <>
              <div className="v1-pm-field">
                <label htmlFor="v1-pm-project-name">Project name</label>
                <Input
                  id="v1-pm-project-name"
                  value={draft.name}
                  maxLength={160}
                  disabled={busy}
                  onChange={(e) =>
                    mutate((old) => ({ ...old, name: e.target.value }))
                  }
                />
              </div>
              <div className="v1-pm-facts">
                <Badge>
                  {
                    draft.conversations.filter(
                      (c) => settingsMembership(draft, c).included
                    ).length
                  }{" "}
                  Conversations
                </Badge>
                <Badge>{draft.selectedSources.size} sources</Badge>
              </div>
              <div className="v1-pm-setting-row">
                <span>Sources</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPanel("sources")}
                >
                  Manage
                  <ChevronRight />
                </Button>
              </div>
              <div className="v1-pm-setting-row">
                <span>Remove Project</span>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmation("delete")}
                >
                  Remove
                </Button>
              </div>
            </>
          )}
          {draft && !editError && panel === "sources" && (
            <>
              <div className="v1-pm-facts">
                <Badge>{draft.selectedSources.size} sources</Badge>
              </div>
              {(["repository", "folder"] as const).map((kind) => (
                <section className="v1-pm-section" key={kind}>
                  <h3>{kind === "repository" ? "Git Anchors" : "Folders"}</h3>
                  <div className="v1-pm-list">
                    {draft.sources
                      .filter((s) => s.kind === kind)
                      .map((source) => (
                        <label className="v1-pm-choice-row" key={source.id}>
                          <Checkbox
                            aria-label={`Include source ${source.name}`}
                            checked={draft.selectedSources.has(source.id)}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              void run(async () =>
                                setDraft(
                                  await selectSettingsSource(
                                    api,
                                    draft,
                                    source.id,
                                    checked
                                  )
                                )
                              )
                            }
                          />
                          {kind === "repository" ? <GitFork /> : <Folder />}
                          <span className="v1-pm-row-copy">
                            <b>{source.name}</b>
                            <small>{source.detail}</small>
                          </span>
                          <Badge variant="outline">
                            {source.previewSessions?.length ??
                              source.threads.length}
                          </Badge>
                        </label>
                      ))}
                  </div>
                  {!draft.sources.some((s) => s.kind === kind) && (
                    <p className="v1-pm-empty">
                      No recorded{" "}
                      {kind === "repository" ? "Git Anchors" : "Folders"}
                    </p>
                  )}
                </section>
              ))}
            </>
          )}
          {draft && !editError && panel === "conversations" && (
            <ConversationsPanel
              draft={draft}
              busy={busy}
              query={query}
              onQuery={setQuery}
              filter={filter}
              onFilter={setFilter}
              suggested={suggested}
              suggestionsLoading={suggestions?.loading ?? false}
              accepted={accepted}
              onAccepted={setAccepted}
              rejected={rejected}
              onRejected={setRejected}
              facts={facts}
              now={now}
              onMembership={(sessionId, next) =>
                mutate((old) => {
                  const memberships = { ...old.memberships };
                  if (next) memberships[sessionId] = next;
                  else delete memberships[sessionId];
                  return { ...old, memberships };
                })
              }
            />
          )}
          {draft && panel === "sync" && (
            <>
              <div className="v1-pm-sync-status">
                <span className="v1-pm-status">
                  {conflict || pending ? (
                    <CircleAlert className="v1-pm-status-warning" />
                  ) : draft.sync ? (
                    <Check className="v1-pm-status-success" />
                  ) : (
                    <RefreshCw />
                  )}
                  {conflict
                    ? "Conflicting changes"
                    : pending
                      ? "Waiting for history"
                      : draft.sync
                        ? "No conflicts"
                        : "Sync status unavailable"}
                </span>
              </div>
              {devices.map((device) => (
                <div className="v1-pm-device-row" key={device}>
                  <Laptop />
                  <span>
                    {projects
                      .flatMap((p) => p.threads)
                      .find((t) => t.originDevice?.id === device)?.originDevice
                      ?.name ?? device}
                  </span>
                </div>
              ))}
              {api.manageMembershipSync && (
                <section className="v1-pm-section">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || dirty}
                    onClick={() => setSyncOpen(true)}
                  >
                    {conflict || pending ? "Review sync" : "Sync details"}
                  </Button>
                </section>
              )}
            </>
          )}
        </div>
        <DialogFooter className="v1-pm-settings-footer">
          <span>{dirty ? footerSummary : ""}</span>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={
              !draft || !!editError || !dirty || !draft.name.trim() || busy
            }
            onClick={() =>
              draft &&
              void run(() =>
                onSave(
                  draft.project,
                  [
                    ...changes,
                    ...rejectedRows.map((row) => ({
                      action: "exclude_session" as const,
                      sessionId: row.sessionId
                    }))
                  ],
                  acceptedRows,
                  rejectedRows
                )
              )
            }
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </div>
      {confirmation && draft && (
        <ProjectPopup
          title={
            confirmation === "delete"
              ? `Remove ${draft.project.name}?`
              : "Discard changes?"
          }
          description={
            confirmation === "delete"
              ? "Conversations and Memory will be kept."
              : undefined
          }
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (confirmation === "delete")
                  void run(() => onDelete(draft.project));
                else if (nextProject) {
                  setActive(nextProject);
                  setPanel("general");
                  setQuery("");
                  setFilter("in");
                  setAccepted(new Set());
                  setRejected(new Set());
                  setNextProject(undefined);
                  setConfirmation(null);
                } else onClose();
              }}
            >
              {confirmation === "delete" ? "Remove Project" : "Discard changes"}
            </Button>
          </DialogFooter>
        </ProjectPopup>
      )}
      {syncOpen && draft && api.manageMembershipSync && (
        <ProjectSyncDetails
          popupClassName="v1-app v1-project-ui v1-pm-dialog v1-pm-action"
          project={draft.project}
          projects={projects}
          manage={api.manageMembershipSync}
          store={store}
          open
          onOpenChange={(open) => {
            setSyncOpen(open);
            if (!open) onClose();
          }}
          onDeleted={onClose}
        />
      )}
    </ProjectPopup>
  );
}
