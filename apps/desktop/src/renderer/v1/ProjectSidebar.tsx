import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
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
  GitFork,
  MessageCircle,
  Pin,
  PinOff,
  Search,
  ArrowRight,
  Ellipsis,
  MessageSquareText,
  Plus,
  Settings2,
  X
} from "lucide-react";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import { Pixelkin } from "./pixelkin/Pixelkin.js";
import { projectKinLook } from "./pixelkin/agent-kin.js";
import {
  filterSidebar,
  isAnchorGroup,
  matchesSidebarConversation,
  namedMemberships,
  NO_ANCHOR_ID,
  openSidebarConversation,
  pinnedFirst,
  projectPinKey,
  sidebarGroups,
  type SidebarConversation,
  type SidebarProject,
  type NavigationRoute
} from "./project-sidebar-model.js";
import { useSidebarPins } from "./use-sidebar-pins.js";
import type { HomeSidebarTourStep } from "./home/HomeSidebarTour.js";
import { useConversationDrag } from "./project-management/use-conversation-drag.js";
import "./project-management/project-management.css";

const CONVERSATIONS_PER_PAGE = 5;
const GROUPS_PER_PAGE = 15;
const LOAD_MORE_THRESHOLD = 120;
const canDragConversation = (row: SidebarConversation) =>
  Boolean(row.sessionId && !row.managementPending);

export type SidebarLive = {
  marker: (row: SidebarConversation) => ReactNode;
  // Opens the row's captured-context panel, anchored on its marker; null when
  // the Kin isn't tracking the row.
  preview?: (
    row: SidebarConversation
  ) => ((anchor: HTMLButtonElement) => void) | null;
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

function ConversationIcon({
  client
}: {
  client: SidebarConversation["client"];
}) {
  return (
    <span className={`v1-nav-client-mark ${client ?? ""}`} aria-hidden="true">
      {client ? <AiClientLogo id={client} /> : <MessageCircle />}
    </span>
  );
}

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

/**
 * End of an infinitely scrolling Projects or Anchors list. It loads the next
 * page whenever it comes into view, including when the first page is short
 * enough that the list never scrolls.
 */
function LoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const node = useRef<HTMLParagraphElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const element = node.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <p className="v1-nav-empty" role="status" ref={node}>
      Loading more…
    </p>
  );
}

export function ProjectSidebar({
  projects,
  route,
  scopeKey,
  onSelect,
  searchRef,
  loading,
  servicesStarting,
  inventoryReady = true,
  anchorInventoryReady = true,
  error,
  onRetry,
  reveal,
  management,
  live,
  tourStep,
  tourProjectId,
  onTourAnchor
}: {
  projects: readonly SidebarProject[];
  route: NavigationRoute;
  scopeKey: string | null;
  onSelect: (route: NavigationRoute) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  loading?: boolean;
  servicesStarting?: boolean;
  inventoryReady?: boolean;
  anchorInventoryReady?: boolean;
  error?: string | null;
  onRetry: () => void;
  // A Project to expand, such as one whose conversation Home just opened.
  // A new key reveals it again.
  reveal?: { projectId: string; key: number } | null;
  management?: SidebarManagement;
  live?: SidebarLive;
  tourStep?: HomeSidebarTourStep;
  tourProjectId?: string;
  onTourAnchor?: (element: HTMLElement | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleCounts, setVisibleCounts] = useState(new Map<string, number>());
  const initialized = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [anchorsOpen, setAnchorsOpen] = useState(false);
  const [projectCount, setProjectCount] = useState(GROUPS_PER_PAGE);
  const [anchorCount, setAnchorCount] = useState(GROUPS_PER_PAGE);
  const [now, setNow] = useState(Date.now);
  const { pins, toggle, ready, error: pinError } = useSidebarPins(scopeKey);
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
  const groups = useMemo(
    () => sidebarGroups(projects, anchorInventoryReady),
    [projects, anchorInventoryReady]
  );
  const memberships = useMemo(() => namedMemberships(projects), [projects]);
  useEffect(() => {
    const first = groups.find((group) => !isAnchorGroup(group));
    if (!initialized.current && first) {
      initialized.current = true;
      setExpanded(new Set([first.id]));
    }
  }, [groups]);
  // Expanding the Project shows the open conversation's highlight. A hidden
  // sidebar stays hidden; when it is showing, the row is scrolled into view.
  useEffect(() => {
    if (!reveal) return;
    // One Project or Anchor is open at a time.
    setExpanded(new Set([reveal.projectId]));
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
  const selected = (row: SidebarConversation) =>
    route.kind === "conversation" && matchesSidebarConversation(route, row);
  const matchingGroups = groups.filter((group) =>
    group.conversations.some(selected)
  );
  const originId =
    route.kind === "conversation"
      ? (route.originGroupId ?? route.projectId)
      : undefined;
  const primaryGroup =
    matchingGroups.find((group) => group.id === originId) ?? matchingGroups[0];
  const primaryGroupId = primaryGroup?.id;
  const primaryRowKey = primaryGroup?.conversations.find(selected)?.key;
  const primaryIsAnchor =
    primaryGroup !== undefined && isAnchorGroup(primaryGroup);
  useEffect(() => {
    if (!primaryGroupId) return;
    setExpanded(new Set([primaryGroupId]));
    if (primaryIsAnchor) setAnchorsOpen(true);
    else setProjectsOpen(true);
  }, [route, primaryGroupId, primaryIsAnchor]);
  const visible = useMemo(
    () => pinnedFirst(filterSidebar(groups, query), pins),
    [groups, query, pins]
  );
  const searching = Boolean(query.trim());
  const projectGroups = visible.filter((group) => !isAnchorGroup(group));
  const anchorGroups = visible.filter(isAnchorGroup);
  const tourProject =
    tourStep === 3
      ? (projectGroups.find(
          ({ id, managed }) => managed && id === tourProjectId
        ) ?? projectGroups.find(({ managed }) => managed))
      : undefined;
  const tourDestinationId = tourProject?.id;
  const tourSource = tourDestinationId
    ? anchorGroups.find((group) =>
        group.conversations.some(canDragConversation)
      )
    : undefined;
  const tourSourceId = tourSource?.id;
  const tourSourceKey =
    tourSource?.conversations.find(canDragConversation)?.key;
  const tourTarget = !tourStep
    ? undefined
    : tourStep === 1 && anchorGroups.length
      ? "anchors"
      : tourStep === 2 && management
        ? "create-project"
        : tourProject
          ? "project"
          : "projects";
  useEffect(() => {
    if (tourStep === 1) setAnchorsOpen(true);
    if (!tourDestinationId) return;
    setProjectsOpen(true);
    if (tourSourceId) {
      setAnchorsOpen(true);
      setExpanded(new Set([tourSourceId]));
    }
    const frame = requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>(
          '[data-home-tour-target="project"][data-home-tour-highlight]'
        )
        ?.scrollIntoView?.({ block: "nearest" });
      contentRef.current
        ?.querySelector<HTMLElement>("[data-home-tour-source]")
        ?.scrollIntoView?.({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [tourStep, tourDestinationId, tourSourceId, tourSourceKey]);
  // Keep the open group and the No anchor fallback accessible on every page.
  const page = (groups: SidebarProject[], count: number) =>
    query.trim()
      ? groups
      : groups.filter(
          (group, index) =>
            index < count ||
            group.id === NO_ANCHOR_ID ||
            expanded.has(group.id) ||
            group.id === tourDestinationId
        );
  const shownProjects = page(projectGroups, projectCount);
  const shownAnchors = page(anchorGroups, anchorCount);
  const loadMoreGroups =
    (shown: number, total: number, grow: (next: number) => void) =>
    (event: { currentTarget: HTMLElement }) => {
      const area = event.currentTarget;
      if (
        shown < total &&
        area.scrollTop + area.clientHeight >=
          area.scrollHeight - LOAD_MORE_THRESHOLD
      )
        grow(shown + GROUPS_PER_PAGE);
    };
  function projectRow(project: SidebarProject) {
    const pinKey = projectPinKey(project.id);
    const open = Boolean(query.trim()) || expanded.has(project.id);
    const limit = visibleCounts.get(project.id) ?? CONVERSATIONS_PER_PAGE;
    // Search covers the full inventory. Keep an older open conversation
    // visible without expanding every conversation ahead of it.
    const shown = query.trim()
      ? project.conversations
      : project.conversations.filter(
          (row, index) =>
            index < limit ||
            selected(row) ||
            (project.id === tourSourceId && row.key === tourSourceKey)
        );
    const remaining = project.conversations.length - shown.length;
    const tourDestination = project.id === tourDestinationId;
    return (
      <SidebarMenuItem
        key={project.id}
        data-project-drop={project.managed ? project.id : undefined}
        className={drag.over === project.id ? "v1-pm-drop-target" : undefined}
      >
        <Collapsible.Root
          open={open}
          onOpenChange={(next) => {
            // Opening one Project or Anchor closes the one that was open.
            setExpanded(next ? new Set([project.id]) : new Set());
            setVisibleCounts((previous) => {
              const changed = new Map(previous);
              changed.delete(project.id);
              return changed;
            });
          }}
        >
          <div
            className={`v1-pm-project-row ${project.managed ? "v1-pm-has-menu" : ""}`}
          >
            <Collapsible.Trigger
              render={<SidebarMenuButton className="v1-nav-project" />}
              ref={tourDestination ? onTourAnchor : undefined}
              data-home-tour-target={project.managed ? "project" : undefined}
              data-home-tour-highlight={tourDestination ? true : undefined}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
              {project.managed ? (
                <Pixelkin
                  look={projectKinLook(
                    project.id,
                    project.kin,
                    project.kinItems
                  )}
                  size={26}
                  className="v1-nav-project-kin"
                  motion="still"
                />
              ) : project.source === "git" ? (
                <GitFork />
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
              {shown.map((row) => conversation(row, project.id))}
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
  function conversation(row: SidebarConversation, groupId: string) {
    const primary = groupId === primaryGroupId && row.key === primaryRowKey;
    const isPinned = pins.some((pin) => row.aliases.includes(pin));
    const projectIds = new Set(
      row.aliases.flatMap((alias) => [...(memberships.get(alias) ?? [])])
    );
    // "Move to Project" replaces a single named membership.
    const moveSource = projectIds.size === 1 ? [...projectIds][0] : undefined;
    // A drag moves the row out of the Project it was dragged from, even when
    // the Conversation is in other Projects too; from an Anchor it only adds.
    const dragRow =
      row.sourceProjectId && projectIds.has(row.sourceProjectId)
        ? row
        : { ...row, sourceProjectId: undefined };
    const canManage =
      row.sessionId && !row.managementPending && !management?.busy;
    const dragging =
      drag.ghost?.groupId === groupId && drag.ghost.row.key === row.key;
    const marker = live?.marker(row) ?? null;
    const showPreview = live?.preview?.(row) ?? null;
    return (
      <SidebarMenuSubItem
        className={`v1-nav-conversation-wrap ${dragging ? "v1-pm-dragging" : ""}`}
        data-live={marker ? true : undefined}
        data-row-key={`${groupId}:${row.key}`}
        key={row.key}
      >
        <SidebarMenuSubButton
          {...drag.handlers(dragRow, groupId)}
          render={<button type="button" />}
          className="v1-nav-conversation"
          data-home-tour-source={
            groupId === tourSourceId && row.key === tourSourceKey
              ? true
              : undefined
          }
          isActive={primary}
          aria-current={primary ? "page" : undefined}
          data-also-open={selected(row) && !primary ? true : undefined}
          title={`${row.title} · ${row.projectName}`}
          onClick={() => onSelect(openSidebarConversation(row, groupId))}
        >
          <ConversationIcon client={row.client} />
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
        </SidebarMenuSubButton>
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
            {showPreview && (
              <DropdownMenuItem
                onClick={() => {
                  const anchor = document.querySelector<HTMLButtonElement>(
                    `[data-row-key=${JSON.stringify(`${groupId}:${row.key}`)}] .fk-row-live`
                  );
                  if (anchor) showPreview(anchor);
                }}
              >
                <MessageSquareText />
                Show captured context
              </DropdownMenuItem>
            )}
            {management && (
              <>
                <DropdownMenuItem
                  disabled={!canManage}
                  onClick={() =>
                    management.onConversationAction(row, "membership")
                  }
                >
                  <Folder />
                  Project memberships
                </DropdownMenuItem>
                {moveSource && (
                  <DropdownMenuItem
                    disabled={!canManage}
                    onClick={() =>
                      management.onConversationAction(
                        { ...row, sourceProjectId: moveSource },
                        "move"
                      )
                    }
                  >
                    <ArrowRight />
                    Move to Project
                  </DropdownMenuItem>
                )}
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
      </SidebarMenuSubItem>
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
        ref={contentRef}
        className="v1-nav-scroll"
        onClickCapture={(event) => {
          if (drag.suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            drag.suppressClick.current = false;
          }
        }}
      >
        <SidebarGroup
          className="v1-nav-projects"
          onScroll={loadMoreGroups(
            shownProjects.length,
            projectGroups.length,
            (next) => setProjectCount((count) => Math.max(count, next))
          )}
        >
          <Collapsible.Root
            open={projectsOpen || searching}
            onOpenChange={setProjectsOpen}
          >
            <div className="v1-nav-heading v1-nav-section-heading v1-pm-project-heading">
              <Collapsible.Trigger
                className="v1-nav-heading-toggle"
                ref={tourTarget === "projects" ? onTourAnchor : undefined}
                data-home-tour-target="projects"
                data-home-tour-highlight={
                  tourTarget === "projects" ? true : undefined
                }
              >
                <ChevronDown
                  className={projectsOpen || searching ? "" : "closed"}
                />
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
                    ref={
                      tourTarget === "create-project" ? onTourAnchor : undefined
                    }
                    data-home-tour-target="create-project"
                    data-home-tour-highlight={
                      tourTarget === "create-project" ? true : undefined
                    }
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
                <SidebarMenu>{shownProjects.map(projectRow)}</SidebarMenu>
                {shownProjects.length < projectGroups.length && (
                  <LoadMoreSentinel
                    // Re-observe after each page: a list that still fits
                    // keeps its sentinel in view without a new change event.
                    key={shownProjects.length}
                    onVisible={() =>
                      setProjectCount((count) =>
                        Math.max(count, shownProjects.length + GROUPS_PER_PAGE)
                      )
                    }
                  />
                )}
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
          <SidebarGroup
            className="v1-nav-anchors"
            onScroll={loadMoreGroups(
              shownAnchors.length,
              anchorGroups.length,
              (next) => setAnchorCount((count) => Math.max(count, next))
            )}
          >
            <Collapsible.Root
              open={anchorsOpen || searching}
              onOpenChange={setAnchorsOpen}
            >
              <div className="v1-nav-heading v1-nav-section-heading">
                <Collapsible.Trigger
                  className="v1-nav-heading-toggle"
                  ref={tourTarget === "anchors" ? onTourAnchor : undefined}
                  data-home-tour-target="anchors"
                  data-home-tour-highlight={
                    tourTarget === "anchors" ? true : undefined
                  }
                >
                  <ChevronDown
                    className={anchorsOpen || searching ? "" : "closed"}
                  />
                  <span>Anchors</span>
                </Collapsible.Trigger>
              </div>
              <Collapsible.Panel>
                <SidebarGroupContent>
                  <SidebarMenu>{shownAnchors.map(projectRow)}</SidebarMenu>
                  {shownAnchors.length < anchorGroups.length && (
                    <LoadMoreSentinel
                      key={shownAnchors.length}
                      onVisible={() =>
                        setAnchorCount((count) =>
                          Math.max(count, shownAnchors.length + GROUPS_PER_PAGE)
                        )
                      }
                    />
                  )}
                </SidebarGroupContent>
              </Collapsible.Panel>
            </Collapsible.Root>
          </SidebarGroup>
        )}
      </SidebarContent>
      {drag.ghost &&
        createPortal(
          <div
            className="v1-app v1-pm-drag-ghost"
            aria-hidden="true"
            style={{
              transform: `translate(${drag.ghost.x + 12}px, ${drag.ghost.y + 12}px)`
            }}
          >
            <ConversationIcon client={drag.ghost.row.client} />
            <span className="v1-pm-drag-title">{drag.ghost.row.title}</span>
          </div>,
          document.body
        )}
    </>
  );
}
