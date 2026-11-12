import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
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
  ChevronsDownUp,
  Folder,
  FolderOpen,
  MessageCircle,
  Pin,
  PinOff,
  Search,
  ArrowRight,
  Ellipsis,
  Plus,
  Settings2,
  X
} from "lucide-react";
import { AiClientLogo } from "../views/personal/AiClientLogo.js";
import {
  filterSidebar,
  pinnedConversations,
  type SidebarConversation,
  type SidebarProject,
  type NavigationRoute
} from "./project-sidebar-model.js";
import { useSidebarPins } from "./use-sidebar-pins.js";
import { useConversationDrag } from "./project-management/use-conversation-drag.js";
import "./project-management/project-management.css";

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
  management
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
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initialized = useRef(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
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
    () => filterSidebar(projects, query),
    [projects, query]
  );
  const pinned = pinnedConversations(visible, pins);
  const selected = (row: SidebarConversation) =>
    route.kind === "conversation" &&
    (route.executionId
      ? row.route.executionId === route.executionId
      : route.projectId === row.route.projectId &&
        route.threadId === row.route.threadId);
  function conversation(row: SidebarConversation, nested: boolean) {
    const isPinned = pins.some((pin) => row.aliases.includes(pin));
    const Row = nested ? SidebarMenuSubItem : SidebarMenuItem;
    const RowButton = nested ? SidebarMenuSubButton : SidebarMenuButton;
    const canManage =
      row.sessionId && !row.managementPending && !management?.busy;
    return (
      <Row
        className={`v1-nav-conversation-wrap ${drag.ghost?.row.key === row.key ? "v1-pm-dragging" : ""}`}
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
          <span
            className={`v1-nav-client-mark ${row.client ?? ""}`}
            aria-hidden="true"
          >
            {row.client ? <AiClientLogo id={row.client} /> : <MessageCircle />}
          </span>
          <span className="v1-nav-copy">
            <span>{row.title}</span>
            {!nested && (
              <small>
                {row.projectName}
                {row.client
                  ? ` · ${{ codex: "Codex", claude: "Claude Code", pi: "Pi" }[row.client]}`
                  : ""}
              </small>
            )}
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
            aria-label="Find a Conversation"
            placeholder="Find a Conversation…"
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
        <SidebarGroup className="v1-nav-pinned">
          <Collapsible.Root open={pinnedOpen} onOpenChange={setPinnedOpen}>
            <Collapsible.Trigger className="v1-nav-heading">
              <ChevronDown className={pinnedOpen ? "" : "closed"} />
              <Pin />
              <span>Pinned</span>
              <small>{pinned.length}</small>
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {pinned.map((row) => conversation(row, false))}
                </SidebarMenu>
                {!pinned.length && (
                  <p className="v1-nav-empty">
                    {query && showEmptyStates
                      ? "No matching pins"
                      : "Pin conversations to keep them here."}
                  </p>
                )}
              </SidebarGroupContent>
            </Collapsible.Panel>
          </Collapsible.Root>
        </SidebarGroup>
        <SidebarGroup className="v1-nav-projects">
          <div className="v1-nav-heading v1-pm-project-heading">
            <span>Projects</span>
            <div>
              {management && (
                <>
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
                </>
              )}
              <button
                type="button"
                aria-label="Collapse all Projects"
                title="Collapse all Projects"
                onClick={() => setExpanded(new Set())}
              >
                <ChevronsDownUp />
              </button>
            </div>
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {visible.map((project) => {
                const open = Boolean(query.trim()) || expanded.has(project.id);
                return (
                  <SidebarMenuItem
                    key={project.id}
                    data-project-drop={project.managed ? project.id : undefined}
                    className={
                      drag.over === project.id ? "v1-pm-drop-target" : undefined
                    }
                  >
                    <Collapsible.Root
                      open={open}
                      onOpenChange={(next) =>
                        setExpanded((previous) => {
                          const changed = new Set(previous);
                          if (next) changed.add(project.id);
                          else changed.delete(project.id);
                          return changed;
                        })
                      }
                    >
                      <div
                        className={`v1-pm-project-row ${management && project.managed ? "v1-pm-has-menu" : ""}`}
                      >
                        <Collapsible.Trigger
                          render={
                            <SidebarMenuButton className="v1-nav-project" />
                          }
                        >
                          {open ? <ChevronDown /> : <ChevronRight />}
                          {open ? <FolderOpen /> : <Folder />}
                          <span>{project.name}</span>
                          <small>{project.conversations.length}</small>
                        </Collapsible.Trigger>
                        {management && project.managed && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="v1-pm-row-menu"
                            aria-label={`Settings for ${project.name}`}
                            title="Project settings"
                            disabled={management.busy}
                            onClick={() =>
                              management.onProjectSettings(project.id)
                            }
                          >
                            <Ellipsis />
                          </Button>
                        )}
                      </div>
                      <Collapsible.Panel>
                        <SidebarMenuSub className="v1-nav-children">
                          {project.conversations.map((row) =>
                            conversation(row, true)
                          )}
                          {!project.conversations.length && showEmptyStates && (
                            <li className="v1-nav-empty">
                              No conversations yet
                            </li>
                          )}
                        </SidebarMenuSub>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
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
        </SidebarGroup>
      </SidebarContent>
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
