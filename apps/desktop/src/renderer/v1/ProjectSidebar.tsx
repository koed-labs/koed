import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
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
} from "@koed/ui";
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
  error,
  onRetry,
  reveal
}: {
  projects: readonly SidebarProject[];
  route: NavigationRoute;
  scopeKey: string | null;
  onSelect: (route: NavigationRoute) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  loading?: boolean;
  error?: string | null;
  onRetry: () => void;
  // A Project to expand, such as one whose conversation Home just opened.
  // A new key reveals it again.
  reveal?: { projectId: string; key: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const initialized = useRef(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [now, setNow] = useState(Date.now);
  const { pins, toggle, ready, error: pinError } = useSidebarPins(scopeKey);
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
    const Button = nested ? SidebarMenuSubButton : SidebarMenuButton;
    return (
      <Row className="v1-nav-conversation-wrap" key={row.key}>
        <Button
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
        </Button>
        <button
          type="button"
          className={`v1-nav-pin ${isPinned ? "is-pinned" : ""}`}
          disabled={!ready}
          aria-label={`${isPinned ? "Unpin" : "Pin"} ${row.title}`}
          title={isPinned ? "Unpin conversation" : "Pin conversation"}
          onClick={() => toggle(row.key, row.aliases)}
        >
          {isPinned ? <PinOff /> : <Pin />}
        </button>
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
      <SidebarContent className="v1-nav-scroll">
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
                    {query
                      ? "No matching pins"
                      : "Pin conversations to keep them here."}
                  </p>
                )}
              </SidebarGroupContent>
            </Collapsible.Panel>
          </Collapsible.Root>
        </SidebarGroup>
        <SidebarGroup className="v1-nav-projects">
          <div className="v1-nav-heading">
            <span>Projects</span>
            <button
              type="button"
              aria-label="Collapse all Projects"
              title="Collapse all Projects"
              onClick={() => setExpanded(new Set())}
            >
              <ChevronsDownUp />
            </button>
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {visible.map((project) => {
                const open = Boolean(query.trim()) || expanded.has(project.id);
                return (
                  <SidebarMenuItem key={project.id}>
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
                      <Collapsible.Panel>
                        <SidebarMenuSub className="v1-nav-children">
                          {project.conversations.map((row) =>
                            conversation(row, true)
                          )}
                          {!project.conversations.length && (
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
          {loading && (
            <p className="v1-nav-empty" role="status">
              Loading conversations…
            </p>
          )}
          {!visible.length && !loading && (
            <p className="v1-nav-empty">
              {query
                ? "No matching conversations or Projects"
                : "No conversations yet"}
            </p>
          )}
          {error && (
            <p className="v1-nav-empty" role="alert">
              {error}{" "}
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
    </>
  );
}
