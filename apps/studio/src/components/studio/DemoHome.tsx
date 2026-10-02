"use client";

import {
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronRight,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Send,
  ShieldCheck,
  Users
} from "lucide-react";
import { type FormEvent, useReducer, useState } from "react";
import {
  DEMO_CHATS,
  DEMO_HOME_ITEMS,
  DEMO_PROJECTS,
  demoItemsForState,
  demoReducer,
  INITIAL_DEMO_STATE,
  type DemoState
} from "@/lib/studio-home-demo";
import { DEMO_BUILD_ACTIVITY } from "@/lib/studio-build-activity";
import { BuildActivityPanel } from "../BuildActivityPanel";
import { FeaturedInvitation, RowInvitation, TileInvitation } from "../KoedHome";
import { NewChatView } from "./NewChatView";
import { StudioSidebar } from "./StudioSidebar";

function DemoNotice() {
  return (
    <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
      Demo data
    </span>
  );
}

function ScreenHeader({
  title,
  onBack
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <header className="z-10 flex h-14 items-center gap-3 bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
      <button
        type="button"
        onClick={onBack}
        className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground no-drag"
        aria-label="Back to Home"
        title="Back to Home"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <p className="text-sm text-foreground no-drag">{title}</p>
    </header>
  );
}

function SimulatedLabel() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-subtle">
      <CircleAlert className="h-3 w-3" /> Simulated
    </span>
  );
}

function ChatScreen({
  state,
  dispatch,
  onBack
}: {
  state: DemoState;
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState("");
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    dispatch({ type: "send-chat", text });
    setDraft("");
  };
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ScreenHeader title="Plan the database migration" onBack={onBack} />
        <main className="flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl pb-20 pt-6">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-subtle">
                  Data migration · Ongoing chat
                </p>
                <h1 className="mt-2 text-xl font-medium text-foreground">
                  Continue the migration plan
                </h1>
              </div>
              <SimulatedLabel />
            </div>
            <div className="space-y-3">
              <div className="max-w-2xl rounded-xl border border-border bg-surface/40 px-4 py-3">
                <p className="text-xs font-medium text-subtle">You · earlier</p>
                <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
                  The backfill is ready. I still need to verify the rollback
                  path before scheduling the maintenance window.
                </p>
              </div>
              <div className="ml-auto max-w-2xl rounded-xl border border-accent/20 bg-accent/10 px-4 py-3">
                <p className="text-xs font-medium text-accent">
                  Koed · simulated
                </p>
                <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
                  The rollback can stop after the checkpoint table is restored.
                  The authentication change briefing may affect that checkpoint.
                </p>
              </div>
              {state.chatMessages.map((message, index) => (
                <div
                  key={`${message}-${index}`}
                  className="ml-auto max-w-2xl rounded-xl border border-border bg-surface px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-subtle">You</p>
                    <SimulatedLabel />
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
                    {message}
                  </p>
                </div>
              ))}
            </div>
            <form onSubmit={send} className="mt-6 flex items-center gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a simulated message"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none placeholder:text-subtle focus:border-border-strong"
                aria-label="Simulated chat message"
              />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md bg-chip px-3 py-2 text-sm font-medium text-chip-foreground disabled:opacity-50"
                disabled={!draft.trim()}
              >
                <Send className="h-3.5 w-3.5" /> Send
              </button>
            </form>
            <p className="mt-2 text-xs text-subtle">
              Messages stay in this demo tab and are never sent to an AI Client.
            </p>
          </div>
        </main>
      </div>
      <BuildActivityPanel
        activity={DEMO_BUILD_ACTIVITY}
        className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-2xl"
      />
    </div>
  );
}

function CollaborationScreen({
  state,
  dispatch,
  onBack
}: {
  state: DemoState;
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState("");
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    dispatch({ type: "reply-collaboration", text });
    setDraft("");
  };
  return (
    <>
      <ScreenHeader title="Project X discussion" onBack={onBack} />
      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl pb-20 pt-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-accent">
                Project X · Unread discussion
              </p>
              <h1 className="mt-2 text-xl font-medium text-foreground">
                Authentication approach
              </h1>
            </div>
            <Users className="h-5 w-5 text-accent" />
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-surface/40 px-4 py-3">
              <p className="text-xs font-medium text-foreground-secondary">
                Alice · 18 min ago
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                I updated the ADR to use provider IDs instead of email as the
                session key. Can we confirm the migration owns that mapping?
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface/40 px-4 py-3">
              <p className="text-xs font-medium text-foreground-secondary">
                Bob · 9 min ago
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                The migration script can carry both values for one release. I
                left a note on the rollback checklist.
              </p>
            </div>
            {state.collaborationReplies.map((reply, index) => (
              <div
                key={`${reply}-${index}`}
                className="rounded-xl border border-accent/20 bg-accent/10 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-accent">
                    You · local reply
                  </p>
                  <SimulatedLabel />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
                  {reply}
                </p>
              </div>
            ))}
          </div>
          <form onSubmit={send} className="mt-6 flex items-center gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Reply in the simulated discussion"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none placeholder:text-subtle focus:border-border-strong"
              aria-label="Simulated discussion reply"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-chip px-3 py-2 text-sm font-medium text-chip-foreground disabled:opacity-50"
              disabled={!draft.trim()}
            >
              <Send className="h-3.5 w-3.5" /> Reply
            </button>
          </form>
        </div>
      </main>
    </>
  );
}

function DecisionScreen({
  state,
  dispatch,
  onBack
}: {
  state: DemoState;
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
  onBack: () => void;
}) {
  return (
    <>
      <ScreenHeader title="Agent decision" onBack={onBack} />
      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl pb-20 pt-6">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent">
            <ShieldCheck className="h-3.5 w-3.5" /> Needs you · Data migration
          </div>
          <h1 className="mt-3 text-2xl font-medium text-foreground">
            Approve the index backfill
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            The migration agent proposes creating{" "}
            <code className="text-foreground-secondary">
              accounts_provider_id_idx
            </code>{" "}
            during the next maintenance window. It will pause before applying
            any destructive change.
          </p>
          <div className="mt-6 rounded-xl border border-border bg-surface/40 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">
              Proposed steps
            </p>
            <ul className="mt-3 space-y-2 text-sm text-foreground-secondary">
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 text-success" />
                Create the index concurrently.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 text-success" />
                Verify duplicate provider IDs.
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 text-success" />
                Pause before the cutover.
              </li>
            </ul>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: "decide", decision: "approved" })}
              disabled={state.decision !== "pending"}
              className="rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground disabled:opacity-50"
            >
              Approve locally
            </button>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "decide", decision: "changes-requested" })
              }
              disabled={state.decision !== "pending"}
              className="rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-foreground-secondary disabled:opacity-50"
            >
              Request changes locally
            </button>
            {state.decision !== "pending" && (
              <span className="text-sm text-success">
                {state.decision === "approved"
                  ? "Local decision recorded: approved."
                  : "Local decision recorded: changes requested."}
              </span>
            )}
          </div>
          <p className="mt-3 text-xs text-subtle">
            This decision is simulated and does not start or change an agent.
          </p>
        </div>
      </main>
    </>
  );
}

function ReviewScreen({
  state,
  dispatch,
  onBack
}: {
  state: DemoState;
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
  onBack: () => void;
}) {
  return (
    <>
      <ScreenHeader title="Agent work review" onBack={onBack} />
      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl pb-20 pt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-warning">
            Agent review · Data migration
          </p>
          <h1 className="mt-3 text-2xl font-medium text-foreground">
            Check the migration agent&apos;s work
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            The dry run completed locally with one warning in the rollback
            verification.
          </p>
          <div className="mt-6 overflow-hidden rounded-xl border border-border bg-surface/40">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-foreground-secondary">
              <GitBranch className="h-4 w-4 text-warning" />{" "}
              migration/backfill-index
            </div>
            <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-foreground-secondary">
              <code>
                {
                  "- rollback/checkpoint.sql\n+ restore checkpoint before cutover\n+ verify provider_id mapping\n  -- warning: legacy email key remains in one fixture"
                }
              </code>
            </pre>
          </div>
          <div className="mt-5 space-y-2 text-sm text-foreground-secondary">
            {[
              "Backfill is idempotent",
              "Index creation is concurrent",
              "Rollback checkpoint is documented",
              "Legacy key warning has an owner"
            ].map((label, index) => (
              <div key={label} className="flex items-center gap-2">
                {index < 3 ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-warning" />
                )}
                {label}
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: "review", decision: "accepted" })}
              disabled={state.reviewDecision !== "pending"}
              className="rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground disabled:opacity-50"
            >
              Accept locally
            </button>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "review", decision: "follow-up" })
              }
              disabled={state.reviewDecision !== "pending"}
              className="rounded-md border border-border-strong px-4 py-2 text-sm font-medium text-foreground-secondary disabled:opacity-50"
            >
              Request follow-up locally
            </button>
            {state.reviewDecision !== "pending" && (
              <span className="text-sm text-success">
                Local review decision recorded.
              </span>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

function BriefingScreen({
  dispatch,
  onBack
}: {
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
  onBack: () => void;
}) {
  const [source, setSource] = useState<"before" | "after" | null>(null);
  return (
    <>
      <ScreenHeader title="Change briefing" onBack={onBack} />
      <main className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl pb-20 pt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-subtle">
            Relevant to your current work · Project X
          </p>
          <h1 className="mt-3 text-2xl font-medium text-foreground">
            Project X changed its authentication approach
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            The team replaced email-based session keys with provider IDs. Your
            current database migration touches the same session table, so the
            backfill needs to carry both values through the transition.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setSource("before")}
              className="rounded-xl border border-border bg-surface/40 p-4 text-left hover:bg-surface"
            >
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">
                Before
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">
                ADR-042 · revision 17
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Sessions keyed by normalized email.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setSource("after")}
              className="rounded-xl border border-accent/30 bg-accent/10 p-4 text-left hover:bg-accent/15"
            >
              <p className="text-[11px] font-medium uppercase tracking-wide text-accent">
                After
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">
                ADR-042 · revision 18
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Sessions keyed by provider ID, with a temporary email bridge.
              </p>
            </button>
          </div>
          {source && (
            <div className="mt-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground-secondary">
              <p className="font-medium text-foreground">
                Local source reference
              </p>
              <p className="mt-1 text-muted">
                {source === "before"
                  ? "ADR-042 revision 17: email was the stable session key."
                  : "ADR-042 revision 18: provider_id is stable; email remains only during migration."}
              </p>
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: "open",
                  screen: { type: "collaboration", id: "collab-auth" }
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-chip px-4 py-2 text-sm font-medium text-chip-foreground"
            >
              <MessageSquare className="h-3.5 w-3.5" /> Open discussion
            </button>
            <span className="text-xs text-subtle">
              Source references are local demo records.
            </span>
          </div>
        </div>
      </main>
    </>
  );
}

function DemoScreenView({
  state,
  dispatch
}: {
  state: DemoState;
  dispatch: React.Dispatch<Parameters<typeof demoReducer>[1]>;
}) {
  const onBack = () => dispatch({ type: "open", screen: { type: "home" } });
  switch (state.screen.type) {
    case "new-chat":
      return <NewChatView mode="demo" onBack={onBack} />;
    case "chat":
      return <ChatScreen state={state} dispatch={dispatch} onBack={onBack} />;
    case "collaboration":
      return (
        <CollaborationScreen
          state={state}
          dispatch={dispatch}
          onBack={onBack}
        />
      );
    case "decision":
      return (
        <DecisionScreen state={state} dispatch={dispatch} onBack={onBack} />
      );
    case "review":
      return <ReviewScreen state={state} dispatch={dispatch} onBack={onBack} />;
    case "briefing":
      return <BriefingScreen dispatch={dispatch} onBack={onBack} />;
    case "home":
      return null;
  }
}

export function DemoHome({
  onPlugins,
  onPullRequests,
  initialNewChat = false
}: {
  onPlugins?: () => void;
  onPullRequests?: () => void;
  initialNewChat?: boolean;
}) {
  const [state, dispatch] = useReducer(
    demoReducer,
    initialNewChat
      ? { ...INITIAL_DEMO_STATE, screen: { type: "new-chat" as const } }
      : INITIAL_DEMO_STATE
  );
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const items = demoItemsForState(state, state.selectedProject);
  const featured = items[0] ?? null;
  const support = items.slice(1, 5);
  const more = items.slice(5);
  const openItem = (item: (typeof DEMO_HOME_ITEMS)[number]) => {
    dispatch({ type: "open", screen: item.demoDestination });
  };
  const resetDemo = () => {
    dispatch({ type: "reset" });
    setMoreOpen(false);
  };
  const openHome = () => dispatch({ type: "open", screen: { type: "home" } });
  const activeScreen =
    state.screen.type === "home"
      ? null
      : state.screen.type === "new-chat"
        ? "new-chat"
        : state.screen.id;

  return (
    <div className="flex h-full min-h-0 w-full">
      <StudioSidebar
        projects={DEMO_PROJECTS}
        chats={DEMO_CHATS}
        homeBadgeCount={0}
        collapsed={collapsed}
        selectedProject={state.selectedProject}
        onProjectSelect={(projectId) =>
          dispatch({ type: "select-project", projectId: projectId || null })
        }
        onToggle={() => setCollapsed((value) => !value)}
        onHome={openHome}
        onNewChat={() =>
          dispatch({ type: "open", screen: { type: "new-chat" } })
        }
        onPullRequests={onPullRequests}
        onPlugins={onPlugins}
        activeSection={
          state.screen.type === "new-chat"
            ? "new-chat"
            : state.screen.type === "home"
              ? "home"
              : undefined
        }
        onChatSelect={(chatId) => {
          if (chatId === "chat-migration")
            dispatch({ type: "open", screen: { type: "chat", id: chatId } });
        }}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        {state.screen.type !== "home" ? (
          <DemoScreenView state={state} dispatch={dispatch} />
        ) : (
          <>
            <header className="z-10 flex h-14 items-center justify-between bg-background/80 px-4 pt-4 backdrop-blur-sm drag-region">
              <p className="text-sm text-foreground no-drag">Home</p>
              <div className="flex items-center gap-2 no-drag">
                <DemoNotice />
                <button
                  type="button"
                  onClick={resetDemo}
                  title="Reset demo"
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset demo
                </button>
                {/* A plain link avoids Next prefetching the live gateway when leaving the demo. */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a
                  href="/"
                  className="rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-hover hover:text-foreground"
                >
                  Return to live Home
                </a>
              </div>
            </header>
            <main className="flex-1 overflow-y-auto p-4">
              <div className="mx-auto max-w-4xl pb-20 pt-6">
                <div className="mb-6 flex items-center justify-between gap-4 px-1">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-subtle">
                    <MessageSquare className="h-3 w-3 text-faint" /> Suggested
                    by Koed
                  </p>
                  <div className="flex shrink-0 items-center gap-1 no-drag">
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({ type: "open", screen: { type: "new-chat" } })
                      }
                      className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface-hover hover:text-foreground"
                    >
                      New chat
                    </button>
                    <button
                      type="button"
                      disabled
                      title="Project setup will be connected in the next page"
                      className="rounded-md px-3 py-1.5 text-sm text-muted opacity-60"
                    >
                      New project
                    </button>
                  </div>
                </div>
                {featured ? (
                  <div className="space-y-8">
                    <FeaturedInvitation
                      item={featured}
                      onOpen={() => openItem(featured)}
                    />
                    {support.length > 0 && (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {support.map((item) => (
                          <TileInvitation
                            key={item.id}
                            item={item}
                            onOpen={() => openItem(item)}
                          />
                        ))}
                      </div>
                    )}
                    {more.length > 0 && (
                      <div>
                        <button
                          type="button"
                          aria-expanded={moreOpen}
                          aria-controls="demo-more-items"
                          onClick={() => setMoreOpen((value) => !value)}
                          className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-[0.18em] text-subtle transition-colors hover:text-foreground-secondary"
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 transition-transform duration-200 ${moreOpen ? "rotate-90" : ""}`}
                          />
                          More from Koed{" "}
                          <span className="text-faint">{more.length}</span>
                        </button>
                        {moreOpen && (
                          <div
                            id="demo-more-items"
                            className="mt-3 space-y-0.5"
                          >
                            {more.map((item) => (
                              <RowInvitation
                                key={item.id}
                                item={item}
                                onOpen={() => openItem(item)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="px-1 text-sm text-subtle">
                    No demo items match this project.
                  </p>
                )}
              </div>
            </main>
          </>
        )}
        {activeScreen && (
          <span className="sr-only">Demo screen: {activeScreen}</span>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        Demo data. No backend writes.
      </span>
    </div>
  );
}
