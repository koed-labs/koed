"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Folder,
  MessageSquare,
  PanelLeft,
  RotateCcw,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { CURRENT_USER_ID, relativeTime } from "@/lib/collab";
import { buildHomeFeed, type HomeItem, type HomeUrgency } from "@/lib/home";
import {
  parseStudioClearedAttention,
  restoreStudioAttentionItem,
  studioAttentionStorageKey,
  type StudioClearedAttention,
} from "@/lib/studio-attention";
import { teamTone } from "@/lib/identity";
import { resolveThreadTitle } from "@/lib/workspace";
import { ChatComposer } from "./ChatComposer";
import { CollapsibleSection } from "./Collapsible";
import { GlobalNav } from "./GlobalNav";
import { ProjectSidebar } from "./ProjectSidebar";
import { SidePanel } from "./SidePanel";
import { useSidePanel } from "./SidePanelContext";
import { useSidebar } from "./SidebarContext";
import { Tooltip } from "./Tooltip";
import { useWorkspace } from "./WorkspaceProvider";
import { CreateProjectModal } from "./CreateProjectModal";

const CLEAR_STATE_KEY = studioAttentionStorageKey("personal-preview");
const EMPTY_CLEARED: StudioClearedAttention = {};
const clearListeners = new Set<() => void>();
let clearSnapshot: StudioClearedAttention | null = null;

function subscribeToCleared(listener: () => void) {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}

function readCleared() {
  if (clearSnapshot) return clearSnapshot;
  try {
    clearSnapshot = CLEAR_STATE_KEY
      ? parseStudioClearedAttention(JSON.parse(window.localStorage.getItem(CLEAR_STATE_KEY) ?? "{}"))
      : EMPTY_CLEARED;
  } catch {
    clearSnapshot = EMPTY_CLEARED;
  }
  return clearSnapshot;
}

function updateCleared(updater: (current: StudioClearedAttention) => StudioClearedAttention) {
  clearSnapshot = updater(readCleared());
  try {
    if (CLEAR_STATE_KEY) window.localStorage.setItem(CLEAR_STATE_KEY, JSON.stringify(clearSnapshot));
  } catch {
    // Clear/restore still works for this visit when storage is unavailable.
  }
  clearListeners.forEach((listener) => listener());
}

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function itemSignature(item: HomeItem) {
  return JSON.stringify([item.title, item.detail, item.kicker]);
}

function previewCopy(item: HomeItem): HomeItem {
  if (item.detail.includes("Koed can summarize")) {
    return { ...item, detail: "Example activity for this browser-local project; no folder is read." };
  }
  if (item.detail.includes("Koed will surface reviews")) {
    return { ...item, detail: "Pull request data is not connected in this preview." };
  }
  if (item.detail.includes("Koed will rank") || item.detail.includes("Koed will tell you")) {
    return { ...item, detail: "Example prompt for this browser-local preview." };
  }
  return item;
}

function lastAgentLine(item: { messages: { role: string; content: string }[] }) {
  const reply = [...item.messages].reverse().find((message) => message.role === "agent");
  return reply ? `Local preview reply · ${reply.content.replace(/\s+/g, " ").trim()}` : "";
}

function UrgencyMark({ urgency }: { urgency: HomeUrgency }) {
  const tone = urgency === "now" ? "bg-accent" : urgency === "soon" ? "bg-warning" : "bg-subtle";
  return <span aria-hidden="true" className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${tone}`} />;
}

function PreviewActionRow({
  item,
  onOpen,
  onClear,
}: {
  item: HomeItem;
  onOpen: () => void;
  onClear: () => void;
}) {
  const canOpen = item.destination.type !== "pull-requests";
  return (
    <li className="group relative">
      <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-hover/50">
        <UrgencyMark urgency={item.urgency} />
                <button
          type="button"
          disabled={!canOpen}
          title={canOpen ? "Open in this local preview" : "Pull requests are not connected in this local preview"}
          onClick={onOpen}
          className={`min-w-0 flex-1 text-left ${canOpen ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
        >
          <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-subtle">
            {item.team && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${teamTone(item.team.id).solid}`} />}
            <span className="min-w-0 flex-1 truncate">{item.detail}</span>
            {item.project && <span className="max-w-[35%] flex-shrink-0 truncate text-faint">{item.project.name}</span>}
          </span>
        </button>
        {!canOpen ? (
          <span className="hidden text-[11px] text-warning sm:inline">Preview only</span>
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-faint group-hover:text-foreground-secondary" />
        )}
        <Tooltip content="Clear until this changes" side="left">
          <button
            type="button"
            aria-label={`Clear ${item.title}`}
            onClick={onClear}
            className="rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground-secondary focus:opacity-100 group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}

export function PersonalPreviewWorkspace() {
  const { isOpen, toggleSidebar } = useSidebar();
  const router = useRouter();
  const { reasons, showReasons, clearReasons } = useSidePanel();
  const {
    workspace,
    previousSessionAt,
    activeThread,
    personalView,
    addProject,
    sendMessage,
    setActiveThreadId,
    startDraft,
    openCollaborative,
  } = useWorkspace();
  const [draft, setDraft] = useState("");
  const [composerKey, setComposerKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const cleared = useSyncExternalStore(subscribeToCleared, readCleared, () => EMPTY_CLEARED);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingProjectDraftRef = useRef<string | null>(null);
  const initializedMobileLayout = useRef(false);
  const toggleSidebarRef = useRef(toggleSidebar);

  useEffect(() => {
    toggleSidebarRef.current = toggleSidebar;
  }, [toggleSidebar]);

  const feed = useMemo(() => buildHomeFeed(workspace, previousSessionAt), [workspace, previousSessionAt]);
  const personalItems = feed.filter((item) => item.kind === "personal");
  const teamItems = feed.filter((item) => item.kind === "collaborative");
  const visible = personalItems.filter((item) => cleared[item.id] !== itemSignature(item));
  const clearedItems = personalItems.filter((item) => cleared[item.id] === itemSignature(item));
  const personalCount = visible.filter((item) => item.urgency !== "idle").length;
  const teams = workspace.teams.filter((team) => team.members.some((member) => member.id === CURRENT_USER_ID));
  const threads = [...workspace.threads]
    .filter((thread) => thread.messages.length > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const recentProject = [...workspace.projects].sort((left, right) => right.createdAt - left.createdAt)[0];
  const prompts = [
    ...(previousSessionAt ? ["What changed since I was last here?"] : []),
    "What should I work on next?",
    ...(recentProject ? [`Recap where we are on ${recentProject.name}`] : []),
  ];
  const showingChat = personalView === "chat";

  useEffect(() => {
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    if (!initializedMobileLayout.current) {
      initializedMobileLayout.current = true;
      if (isMobile && isOpen) toggleSidebarRef.current();
      return;
    }
    if (!isMobile) return;
    if (isOpen) {
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-mobile-sidebar-close]")?.focus());
    } else {
      sidebarTriggerRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.matchMedia("(max-width: 767px)").matches) {
        event.preventDefault();
        toggleSidebarRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    const projectId = pendingProjectDraftRef.current;
    if (!projectId || !workspace.projects.some((project) => project.id === projectId)) return;
    pendingProjectDraftRef.current = null;
    startDraft(projectId);
  }, [startDraft, workspace.projects]);

  const openItem = (item: HomeItem) => {
    switch (item.destination.type) {
      case "thread":
        setActiveThreadId(item.destination.threadId);
        return;
      case "draft":
        startDraft(item.destination.projectId);
        return;
      case "prompt":
        startDraft(item.destination.projectId);
        setDraft(item.destination.prompt);
        return;
      case "collab":
        openCollaborative(item.destination.landing);
        router.push("/collaboration");
        return;
      case "team":
        openCollaborative({ teamId: item.destination.teamId, projectId: null, view: "inbox" });
        router.push("/collaboration");
        return;
      case "pull-requests":
        return;
    }
  };

  const clearItem = (item: HomeItem) => updateCleared((current) => ({ ...current, [item.id]: itemSignature(item) }));
  const restoreItem = (itemId: string) => updateCleared((current) => restoreStudioAttentionItem(itemId, current));
  const createProject = (input: { name: string; path: string; githubRepo?: string; sharedWith: string[] }) => {
    const slug = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-project";
    const project = addProject({
      name: input.name.trim(),
      path: input.path || `~/preview/${slug}`,
      branch: "local-preview",
      githubRepo: input.githubRepo,
      sharedWith: input.sharedWith,
    });
    setCreateOpen(false);
    setDraft(`Start a local preview chat about ${input.name.trim()}`);
    pendingProjectDraftRef.current = project.id;
  };

  const submit = (text: string) => {
    if (!text.trim()) return;
    sendMessage(text, activeThread?.id ?? null);
    setDraft("");
    clearReasons();
    setComposerKey((current) => current + 1);
  };

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <GlobalNav />
      {isOpen && (
        <>
          <button
            type="button"
            aria-label="Close project sidebar"
            onClick={toggleSidebar}
            className="fixed inset-0 z-30 bg-black/45 md:hidden"
          />
          <ProjectSidebar previewMode mobileOverlay />
        </>
      )}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showingChat ? (
          <>
            <header className="z-10 flex h-14 items-center gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
              <Tooltip content={isOpen ? "Toggle Sidebar" : "Open Sidebar"} side="bottom">
                <button ref={sidebarTriggerRef} type="button" onClick={toggleSidebar} aria-label={isOpen ? "Close sidebar" : "Open sidebar"} className={`rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground ${isOpen ? "md:hidden" : ""}`}>
                  <PanelLeft className="h-4 w-4" />
                </button>
              </Tooltip>
              <div className="min-w-0 truncate pt-1 text-sm text-muted"><span className="font-medium text-foreground-secondary">Personal preview</span><span className="mx-2 text-faint">/</span><span className="text-foreground">{activeThread?.title ?? "New chat"}</span></div>
            </header>
            <div className="flex min-h-0 flex-1">
              <section className="relative min-w-0 flex-1">
                <div className="h-full overflow-y-auto px-4 pb-44 pt-8">
                  <div className="mx-auto max-w-2xl space-y-6">
                    {(!activeThread || activeThread.messages.length === 0) && (
                      <div className="pt-12">
                        <p className="mb-4 text-sm text-subtle">Suggested from local preview data</p>
                        <div className="flex flex-wrap gap-2">
                          {feed.filter((item) => item.destination.type === "prompt").slice(0, 5).map((item) => (
                            <button key={item.id} type="button" className={`rounded-full border px-3 py-1.5 text-left text-xs transition-colors ${reasons?.id === item.id ? "border-border-strong bg-surface-hover text-foreground" : "border-border bg-surface text-foreground-secondary hover:border-border-strong hover:text-foreground"}`} onClick={() => {
                              if (item.destination.type !== "prompt") return;
                              setDraft(item.destination.prompt);
                              showReasons({ id: item.id, label: item.title, prompt: item.destination.prompt, reasons: [{ id: "local-preview", category: "activity", title: "Local preview context", detail: "This suggestion uses browser-local example data only." }] });
                            }}>{item.title}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {activeThread?.messages.map((message) => (
                      <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] ${message.role === "user" ? "rounded-2xl rounded-tr-sm bg-surface-hover px-4 py-3 text-foreground" : "text-foreground-secondary"} text-[15px] leading-relaxed`}>{message.role === "agent" && <span className="mb-1 block text-[11px] text-warning">Browser-local sample reply</span>}{message.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent p-4 pt-10">
                  <div className="mx-auto max-w-2xl">
                    <p className="mb-2 text-center text-[11px] text-warning">Replies are generated locally for preview; no Koed service or agent is contacted.</p>
                    <ChatComposer key={composerKey} placeholder="Message this local preview" projectName="Personal preview" branch="local" footer="Saved only in this browser. No agent, filesystem, or backend is contacted." value={draft} onChange={setDraft} onSend={(text) => submit(text)} />
                  </div>
                </div>
              </section>
              <SidePanel localPreview />
            </div>
          </>
        ) : (
          <>
            <header className="z-10 flex h-14 items-center justify-between gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
              <div className="flex items-center gap-3 no-drag">
                {!isOpen && <Tooltip content="Open Sidebar" side="bottom"><button ref={sidebarTriggerRef} type="button" onClick={toggleSidebar} aria-label="Open sidebar" className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"><PanelLeft className="h-4 w-4" /></button></Tooltip>}
                <p className="text-sm text-foreground">Home</p>
              </div>
              <div className="flex items-center gap-1 no-drag">
                <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-foreground" onClick={() => { startDraft(null); setDraft(""); }}>New chat</button>
                <button type="button" className="rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-foreground" onClick={() => setCreateOpen(true)}>New project</button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-2xl space-y-8 pb-24 pt-8">
                <p className="w-fit rounded-md border border-warning/30 bg-warning/5 px-2 py-1 text-[11px] font-medium text-warning">Local preview · browser data only</p>
                <section>
                  <h1 className="text-[26px] font-medium text-foreground">{greeting()}</h1>
                  <p className="mt-1 text-[15px] text-muted">{personalCount === 0 ? "Nothing here needs you. Start something, or pick up where you left off." : personalCount === 1 ? "1 thing needs you in this local preview." : `${personalCount} things need you in this local preview.`}</p>
                  {teams.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5">{teams.map((team) => {
                    const count = teamItems.filter((item) => item.team?.id === team.id && item.urgency !== "idle").length;
                    return <button key={team.id} type="button" onClick={() => { openCollaborative({ teamId: team.id, projectId: null, view: "inbox" }); router.push("/collaboration"); }} title={`Open local preview for ${team.name}`} className="group flex items-center gap-1.5 rounded-full border border-border py-1 pl-2 pr-2.5 text-xs text-foreground-secondary transition-colors hover:border-border-strong hover:text-foreground"><span className={`h-1.5 w-1.5 rounded-full ${teamTone(team.id).solid}`} />{team.name}{count > 0 ? <span className="rounded-full bg-accent/15 px-1.5 font-medium text-accent">{count}</span> : <span className="text-faint">caught up</span>}<ArrowRight className="h-3 w-3 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground-secondary" /></button>;
                  })}</div>}
                </section>

                <section className="no-drag">
                  <ChatComposer placeholder="Start a local preview chat" projectName="Personal preview" branch="local" value={draft} onChange={setDraft} onSend={(text) => submit(text)} showExecutionControls={false} showMetaBar={false} footer="Preview only. Replies are generated locally and saved in this browser." />
                  <div className="mt-2.5 flex flex-wrap gap-1.5">{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => setDraft(prompt)} className="rounded-full px-2.5 py-1 text-xs text-subtle transition-colors hover:bg-surface-hover hover:text-foreground-secondary">{prompt}</button>)}</div>
                </section>

                <CollapsibleSection id="personal-preview.needs-you" title="Needs you" count={visible.length}>
                  {visible.length ? <div className="overflow-hidden rounded-xl border border-border bg-surface/30"><ul className="divide-y divide-border">{visible.map((item) => <PreviewActionRow key={item.id} item={previewCopy(item)} onOpen={() => openItem(item)} onClear={() => clearItem(item)} />)}</ul></div> : <p className="flex items-center gap-2 px-1 text-sm text-subtle"><CheckCircle2 className="h-4 w-4 flex-shrink-0 text-success" />Nothing on your personal side needs you in this local preview.</p>}
                  {clearedItems.length > 0 && <div className="mt-2 px-1"><ClearedPreviewItems items={clearedItems} onRestore={restoreItem} /></div>}
                </CollapsibleSection>

                <CollapsibleSection id="personal-preview.recent" title="Pick up where you left off" count={threads.length}>
                  {threads.length === 0 ? <p className="px-1 text-sm text-subtle">Local preview chats will appear here once you start one.</p> : <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/30">{threads.map((thread) => {
                    const project = workspace.projects.find((item) => item.id === thread.projectId);
                    return <li key={thread.id}><button type="button" onClick={() => setActiveThreadId(thread.id)} className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/50"><span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-surface-hover text-subtle">{project ? <Folder className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground">{resolveThreadTitle(thread)}</span><span className="block truncate text-xs text-muted">{project ? `${project.name} · ` : ""}{lastAgentLine(thread) || "No local reply yet"}</span></span><span className="flex-shrink-0 text-xs text-faint">{relativeTime(thread.updatedAt)}</span><ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-faint group-hover:text-foreground-secondary" /></button></li>;
                  })}</ul>}
                </CollapsibleSection>

                <CollapsibleSection id="personal-preview.projects" title="Projects" count={workspace.projects.length}>
                  {workspace.projects.length ? <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface/30">{workspace.projects.map((project) => <li key={project.id} className="flex items-center gap-2 px-3 py-2.5 text-sm text-foreground-secondary"><Folder className="h-4 w-4 flex-shrink-0 text-subtle" /><span className="min-w-0 flex-1 truncate">{project.name}</span><span className="flex-shrink-0 text-[11px] text-warning">local metadata</span></li>)}</ul> : <p className="px-1 text-sm text-subtle">No local projects in this browser yet.</p>}
                </CollapsibleSection>
              </div>
            </div>
          </>
        )}
      </main>
      {createOpen && (
        <CreateProjectModal
          teams={teams}
          previewMode
          onClose={() => setCreateOpen(false)}
          onCreate={createProject}
        />
      )}
    </div>
  );

}

function ClearedPreviewItems({ items, onRestore }: { items: HomeItem[]; onRestore: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="flex items-center gap-1.5 text-xs text-subtle transition-colors hover:text-foreground-secondary"><ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />{items.length} cleared</button>
      {open && <div className="mt-2 space-y-0.5">{items.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover/50"><div className="min-w-0 flex-1"><p className="truncate text-xs text-foreground-secondary">{item.title}</p><p className="truncate text-[11px] text-subtle">Browser-local example · Preview only</p></div><button type="button" onClick={() => onRestore(item.id)} className="flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-subtle hover:bg-surface-hover hover:text-foreground-secondary"><RotateCcw className="h-3 w-3" />Restore</button></div>)}</div>}
    </div>
  );
}
