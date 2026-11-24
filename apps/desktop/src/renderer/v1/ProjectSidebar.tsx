import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import type { PersonalProjectKin } from "@koed-labs/shared";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  Collapsible,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem
} from "@koed-labs/ui";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  MessageCircle,
  Pin,
  PinOff,
  Search,
  ArrowRight,
  Ellipsis,
  Plus,
  Settings2,
  Smile,
  X
} from "lucide-react";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import { Pixelkin } from "./pixelkin/Pixelkin.js";
import { DEFAULT_AGENT_LOOK, projectKinLook } from "./pixelkin/agent-kin.js";
import {
  conversationList,
  filterSidebar,
  isAnchorGroup,
  NO_PROJECT_ID,
  pinnedFirst,
  projectPinKey,
  type SidebarConversation,
  type SidebarProject,
  type NavigationRoute
} from "./project-sidebar-model.js";
import { useSidebarPins } from "./use-sidebar-pins.js";
import { useNoProjectKin } from "./use-no-project-kin.js";
import { NoProjectKinDialog } from "./project-management/NoProjectKinDialog.js";
import { useConversationDrag } from "./project-management/use-conversation-drag.js";
import "./project-management/project-management.css";

const CONVERSATIONS_PER_PAGE = 5;
const RECENT_PER_PAGE = 20;
// Load the next page this close (px) to the end of the Conversations list.
const LOAD_MORE_THRESHOLD = 120;

/**
 * Live Chief of Staff state for Conversation rows. `marker` returns a control
 * for a Conversation the Kin is tracking, or null; `status` sums it up beside
 * the Conversations heading.
 */
export type SidebarLive = {
  marker: (row: SidebarConversation) => ReactNode;
  status?: ReactNode;
};

export type SidebarManagement = {
  onCreateProject: () => void;
  onProjectSettings: (projectId?: string) => void;
  onConversationAction: (
    row: SidebarConversation,
    action: "move" | "membership" | "context"
  ) => void;
  onDrop: (row: SidebarConversation, projectId: string) => Promise<unknown>;
  busy?: boolean;
};

function ProjectActions({
  name,
  settings,
  settingsBusy,
  pinned,
  canPin,
  onTogglePin
}: {
  name: string;
  settings?: () => void;
  settingsBusy?: boolean;
  pinned: boolean;
  canPin: boolean;
  onTogglePin: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="v1-pm-row-menu"
            aria-label={`Actions for Project ${name}`}
          >
            <Ellipsis />
          </Button>
        }
      />
      <DropdownMenuPopup
        className="v1-app v1-project-ui v1-pm-menu"
        align="start"
      >
        {settings && (
          <DropdownMenuItem disabled={settingsBusy} onClick={settings}>
            <Settings2 />
            Project settings
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!canPin} onClick={onTogglePin}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? "Unpin Project" : "Pin Project"}
        </DropdownMenuItem>
      </DropdownMenuPopup>
    </DropdownMenu>
  );
}

// No project is not a Project; its only setting is its Kin.
function NoProjectActions({
  canEdit,
  onKinSettings
}: {
  canEdit: boolean;
  onKinSettings: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="v1-pm-row-menu"
            aria-label="Actions for No project"
          >
            <Ellipsis />
          </Button>
        }
      />
      <DropdownMenuPopup
        className="v1-app v1-project-ui v1-pm-menu"
        align="start"
      >
        <DropdownMenuItem disabled={!canEdit} onClick={onKinSettings}>
          <Smile />
          Kin settings
        </DropdownMenuItem>
      </DropdownMenuPopup>
    </DropdownMenu>
  );
}

export const conversationActivity = (value: string, now: number) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
};

// The Project's Kin with the AI Client's badge, as on Chief of Staff chips.
const ConversationKin = memo(function ConversationKin({
  row,
  noProjectKin
}: {
  row: SidebarConversation;
  noProjectKin?: PersonalProjectKin;
}) {
  const projectId = row.route.projectId;
  return (
    <span className="v1-nav-kin" aria-hidden="true">
      <Pixelkin
        look={
          row.noProject
            ? projectKinLook(NO_PROJECT_ID, noProjectKin)
            : projectId
              ? projectKinLook(projectId, row.projectKin)
              : DEFAULT_AGENT_LOOK
        }
        size={42}
        motion="still"
      />
      <span className="v1-nav-kin-client">
        {row.client ? <AiClientLogo id={row.client} /> : <MessageCircle />}
      </span>
    </span>
  );
});

export function ProjectSidebar({
  projects,
  route,
  scopeKey,
  onSelect,
  searchRef,
  loading,
  servicesStarting,
  inventoryReady = true,
  error,
  onRetry,
  reveal,
  management,
  live
}: {
  projects: readonly SidebarProject[];
  route: NavigationRoute;
  scopeKey: string | null;
  onSelect: (route: NavigationRoute) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  loading?: boolean;
  servicesStarting?: boolean;
  inventoryReady?: boolean;
  error?: string | null;
  onRetry: () => void;
  // A Project to expand, such as one whose conversation Home just opened.
  // A new key reveals it again.
  reveal?: { projectId: string; key: number } | null;
  management?: SidebarManagement;
  live?: SidebarLive;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleCounts, setVisibleCounts] = useState(new Map<string, number>());
  const initialized = useRef(false);
  const [listOpen, setListOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [anchorsOpen, setAnchorsOpen] = useState(true);
  const [recentCount, setRecentCount] = useState(RECENT_PER_PAGE);
  const [now, setNow] = useState(Date.now);
  const { pins, toggle, ready, error: pinError } = useSidebarPins(scopeKey);
  const noProjectKin = useNoProjectKin(scopeKey);
  const [editingNoProjectKin, setEditingNoProjectKin] = useState(false);
  const drag = useConversationDrag(
    management?.busy
      ? undefined
      : management?.onDrop &&
          ((row, projectId) => void management.onDrop(row, projectId))
  );
  const showEmptyStates =
    inventoryReady && !loading && !servicesStarting && !error;
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!initialized.current && projects.length) {
      initialized.current = true;
      setExpanded(new Set([projects[0]!.id]));
    }
  }, [projects]);
  // Expanding the Project shows the open conversation's highlight. A hidden
  // sidebar stays hidden; when it is showing, the row is scrolled into view.
  useEffect(() => {
    if (!reveal) return;
    setExpanded((previous) =>
      previous.has(reveal.projectId)
        ? previous
        : new Set(previous).add(reveal.projectId)
    );
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        '.v1-navigation-sidebar [aria-current="page"]'
      );
      const rect = row?.getBoundingClientRect();
      if (row && rect && rect.width > 0 && rect.right > 0)
        row.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal]);
  useEffect(() => {
    if (route.kind === "conversation" && route.projectId) {
      const id = route.projectId;
      setExpanded((previous) => new Set([...previous, id]));
    }
  }, [route]);
  const visible = useMemo(
    () => pinnedFirst(filterSidebar(projects, query), pins),
    [projects, query, pins]
  );
  const selected = (row: SidebarConversation) =>
    route.kind === "conversation" &&
    (route.executionId
      ? row.route.executionId === route.executionId
      : route.projectId === row.route.projectId &&
        route.threadId === row.route.threadId);
  const list = conversationList(visible, pins);
  const projectGroups = visible.filter((project) => !isAnchorGroup(project));
  const anchorGroups = visible.filter(isAnchorGroup);
  // Search covers every Conversation; keep the open one visible otherwise.
  const recent = query.trim()
    ? list.recent
    : list.recent.filter((row, index) => index < recentCount || selected(row));
  const moreRecent = list.recent.length - recent.length;
  function projectRow(project: SidebarProject) {
    const pinKey = projectPinKey(project.id);
    const noProject = project.id === NO_PROJECT_ID;
    const open = Boolean(query.trim()) || expanded.has(project.id);
    const limit = visibleCounts.get(project.id) ?? CONVERSATIONS_PER_PAGE;
    // Search covers the full inventory. Keep an older open conversation
    // visible without expanding every conversation ahead of it.
    const shown = query.trim()
      ? project.conversations
      : project.conversations.filter(
          (row, index) => index < limit || selected(row)
        );
    const remaining = project.conversations.length - shown.length;
    return (
      <SidebarMenuItem
        key={project.id}
        data-project-drop={project.managed ? project.id : undefined}
        className={drag.over === project.id ? "v1-pm-drop-target" : undefined}
      >
        <Collapsible.Root
          open={open}
          onOpenChange={(next) => {
            setExpanded((previous) => {
              const changed = new Set(previous);
              if (next) changed.add(project.id);
              else changed.delete(project.id);
              return changed;
            });
            if (!next)
              setVisibleCounts((previous) => {
                const changed = new Map(previous);
                changed.delete(project.id);
                return changed;
              });
          }}
        >
          <div
            className={`v1-pm-project-row ${project.managed || noProject ? "v1-pm-has-menu" : ""}`}
          >
            <Collapsible.Trigger
              render={<SidebarMenuButton className="v1-nav-project" />}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
              {project.managed || noProject ? (
                <Pixelkin
                  look={
                    noProject
                      ? projectKinLook(NO_PROJECT_ID, noProjectKin.kin)
                      : projectKinLook(project.id, project.kin)
                  }
                  size={30}
                  className="v1-nav-project-kin"
                  motion="still"
                />
              ) : project.source === "git" ? (
                <GitBranch />
              ) : open ? (
                <FolderOpen />
              ) : (
                <Folder />
              )}
              <span>
                {pins.includes(pinKey) && (
                  <Pin className="v1-nav-pin-mark" aria-label="Pinned" />
                )}
                {project.name}
              </span>
            </Collapsible.Trigger>
            {noProject && (
              <NoProjectActions
                canEdit={noProjectKin.ready}
                onKinSettings={() => setEditingNoProjectKin(true)}
              />
            )}
            {project.managed && (
              <ProjectActions
                name={project.name}
                settings={
                  management && (() => management.onProjectSettings(project.id))
                }
                settingsBusy={management?.busy}
                pinned={pins.includes(pinKey)}
                canPin={ready}
                onTogglePin={() => toggle(pinKey, [pinKey])}
              />
            )}
          </div>
          <Collapsible.Panel>
            <SidebarMenuSub className="v1-nav-children">
              {shown.map((row) => conversation(row, true))}
              {remaining > 0 && (
                <SidebarMenuSubItem className="v1-nav-load-more-row">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="v1-nav-load-more"
                    aria-label={`Load more conversations in ${project.name}`}
                    title={`${remaining} more conversations`}
                    onClick={(event) => {
                      const list = event.currentTarget.closest("ul");
                      setVisibleCounts((previous) =>
                        new Map(previous).set(
                          project.id,
                          limit + CONVERSATIONS_PER_PAGE
                        )
                      );
                      requestAnimationFrame(() => {
                        list
                          ?.querySelectorAll<HTMLButtonElement>(
                            ".v1-nav-conversation"
                          )
                          [limit]?.focus();
                      });
                    }}
                  >
                    <Badge>Load More</Badge>
                  </Button>
                </SidebarMenuSubItem>
              )}
              {!project.conversations.length && showEmptyStates && (
                <li className="v1-nav-empty">No conversations yet</li>
              )}
            </SidebarMenuSub>
          </Collapsible.Panel>
        </Collapsible.Root>
      </SidebarMenuItem>
    );
  }
  function conversation(row: SidebarConversation, nested: boolean) {
    const isPinned = pins.some((pin) => row.aliases.includes(pin));
    const Row = nested ? SidebarMenuSubItem : SidebarMenuItem;
    const RowButton = nested ? SidebarMenuSubButton : SidebarMenuButton;
    const canManage =
      row.sessionId && !row.managementPending && !management?.busy;
    const marker = live?.marker(row) ?? null;
    return (
      <Row
        className={`v1-nav-conversation-wrap ${drag.ghost?.row.key === row.key ? "v1-pm-dragging" : ""}`}
        data-live={marker ? true : undefined}
        key={row.key}
      >
        <RowButton
          {...drag.handlers(row)}
          render={<button type="button" />}
          className="v1-nav-conversation"
          isActive={selected(row)}
          aria-current={selected(row) ? "page" : undefined}
          title={`${row.title} · ${row.projectName}`}
          onClick={() => onSelect(row.route)}
        >
          {nested ? (
            <span
              className={`v1-nav-client-mark ${row.client ?? ""}`}
              aria-hidden="true"
            >
              {row.client ? (
                <AiClientLogo id={row.client} />
              ) : (
                <MessageCircle />
              )}
            </span>
          ) : (
            <ConversationKin row={row} noProjectKin={noProjectKin.kin} />
          )}
          <span className="v1-nav-copy">
            <span>
              {isPinned && (
                <Pin className="v1-nav-pin-mark" aria-label="Pinned" />
              )}
              {row.title}
            </span>
          </span>
          <time
            dateTime={row.latestAt || undefined}
            title={
              row.latestAt ? new Date(row.latestAt).toLocaleString() : undefined
            }
          >
            {conversationActivity(row.latestAt, now)}
          </time>
        </RowButton>
        {marker}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="v1-pm-row-menu"
                aria-label={`Actions for ${row.title}`}
              >
                <Ellipsis />
              </Button>
            }
          />
          <DropdownMenuPopup
            className="v1-app v1-project-ui v1-pm-menu"
            align="start"
          >
            {management && (
              <>
                <DropdownMenuItem
                  disabled={!canManage}
                  onClick={() => management.onConversationAction(row, "move")}
                >
                  <ArrowRight />
                  Move to Project
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canManage}
                  onClick={() =>
                    management.onConversationAction(row, "membership")
                  }
                >
                  <Folder />
                  Project memberships
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              disabled={!ready}
              onClick={() => toggle(row.key, row.aliases)}
            >
              {isPinned ? <PinOff /> : <Pin />}
              {isPinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            {management && (
              <DropdownMenuItem
                disabled={!canManage}
                onClick={() => management.onConversationAction(row, "context")}
              >
                <Settings2 />
                Correct source context
              </DropdownMenuItem>
            )}
          </DropdownMenuPopup>
        </DropdownMenu>
      </Row>
    );
  }
  return (
    <>
      <SidebarHeader className="v1-nav-search-header">
        <div className="v1-nav-search">
          <Search aria-hidden="true" />
          <SidebarInput
            ref={searchRef}
            aria-label="Find Projects or Conversations"
            placeholder="Find Projects or Conversations…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X />
            </button>
          ) : (
            <kbd>⌘ K</kbd>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent
        className="v1-nav-scroll"
        onClickCapture={(event) => {
          if (drag.suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            drag.suppressClick.current = false;
          }
        }}
      >
        <SidebarGroup className="v1-nav-conversations">
          <Collapsible.Root open={listOpen} onOpenChange={setListOpen}>
            <div className="v1-nav-heading v1-nav-conversations-heading">
              <Collapsible.Trigger className="v1-nav-heading-toggle">
                <ChevronDown className={listOpen ? "" : "closed"} />
                <span>Conversations</span>
              </Collapsible.Trigger>
              {live?.status}
            </div>
            <Collapsible.Panel>
              <SidebarGroupContent>
                {/* Its own scroll area; nearing the end loads the next page. */}
                <div
                  className="v1-nav-conversations-scroll"
                  onScroll={(event) => {
                    const area = event.currentTarget;
                    if (
                      moreRecent > 0 &&
                      area.scrollTop + area.clientHeight >=
                        area.scrollHeight - LOAD_MORE_THRESHOLD
                    )
                      setRecentCount((count) =>
                        Math.max(count, recent.length + RECENT_PER_PAGE)
                      );
                  }}
                >
                  <SidebarMenu>
                    {list.pinned.map((row) => conversation(row, false))}
                    {recent.map((row) => conversation(row, false))}
                  </SidebarMenu>
                  {moreRecent > 0 && (
                    <p className="v1-nav-empty" role="status">
                      Loading more…
                    </p>
                  )}
                </div>
                {!list.pinned.length &&
                  !list.recent.length &&
                  query &&
                  showEmptyStates && (
                    <p className="v1-nav-empty">No matching Conversations</p>
                  )}
              </SidebarGroupContent>
            </Collapsible.Panel>
          </Collapsible.Root>
        </SidebarGroup>
        {/* Projects and Anchors share one scroll area below Conversations. */}
        <div className="v1-nav-tree">
          <SidebarGroup className="v1-nav-projects">
            <Collapsible.Root
              open={projectsOpen}
              onOpenChange={setProjectsOpen}
            >
              <div className="v1-nav-heading v1-nav-section-heading v1-pm-project-heading">
                <Collapsible.Trigger className="v1-nav-heading-toggle">
                  <ChevronDown className={projectsOpen ? "" : "closed"} />
                  <span>Projects</span>
                </Collapsible.Trigger>
                {management && (
                  <div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Manage all Projects"
                      title="Manage Projects"
                      disabled={management.busy}
                      onClick={() => management.onProjectSettings()}
                    >
                      <Settings2 />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Create Project"
                      title="Create Project"
                      disabled={management.busy}
                      onClick={management.onCreateProject}
                    >
                      <Plus />
                    </Button>
                  </div>
                )}
              </div>
              <Collapsible.Panel>
                <SidebarGroupContent>
                  <SidebarMenu>{projectGroups.map(projectRow)}</SidebarMenu>
                </SidebarGroupContent>
                {(servicesStarting || loading) && (
                  <p className="v1-nav-empty" role="status">
                    {servicesStarting
                      ? "Services starting…"
                      : "Loading conversations…"}
                  </p>
                )}
                {!visible.length && showEmptyStates && (
                  <p className="v1-nav-empty">
                    {query
                      ? "No matching conversations or Projects"
                      : "No conversations yet"}
                  </p>
                )}
                {error && (
                  <p className="v1-nav-empty" role="alert">
                    {error}
                    <button type="button" onClick={onRetry}>
                      Retry
                    </button>
                  </p>
                )}
                {pinError && (
                  <p className="v1-nav-empty" role="alert">
                    {pinError}
                  </p>
                )}
              </Collapsible.Panel>
            </Collapsible.Root>
          </SidebarGroup>
          {anchorGroups.length > 0 && (
            <SidebarGroup className="v1-nav-anchors">
              <Collapsible.Root
                open={anchorsOpen}
                onOpenChange={setAnchorsOpen}
              >
                <div className="v1-nav-heading v1-nav-section-heading">
                  <Collapsible.Trigger className="v1-nav-heading-toggle">
                    <ChevronDown className={anchorsOpen ? "" : "closed"} />
                    <span>Anchors</span>
                  </Collapsible.Trigger>
                </div>
                <Collapsible.Panel>
                  <SidebarGroupContent>
                    <SidebarMenu>{anchorGroups.map(projectRow)}</SidebarMenu>
                  </SidebarGroupContent>
                </Collapsible.Panel>
              </Collapsible.Root>
            </SidebarGroup>
          )}
        </div>
      </SidebarContent>
      {editingNoProjectKin && (
        <NoProjectKinDialog
          kin={noProjectKin.kin}
          onSave={noProjectKin.save}
          onClose={() => setEditingNoProjectKin(false)}
        />
      )}
      {drag.ghost &&
        createPortal(
          <div
            className="v1-app v1-project-ui v1-pm-drag-ghost"
            style={{
              transform: `translate(${drag.ghost.x}px, ${drag.ghost.y}px)`
            }}
          >
            <ArrowRight size={14} />
            <span>{drag.ghost.row.title}</span>
          </div>,
          document.body
        )}
    </>
  );
}
