import type { DesktopApi } from "../../../types.js";
import { assignmentFrom } from "../preferences/local-ai-client-settings-helpers.js";
import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import type {
  PersonalDesktopApi,
  PersonalDesktopAskTurn
} from "@koed/shared/personal-desktop";
import { Folder, LoaderCircle, MessageSquare, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  projectLatestAt,
  type DesktopProject
} from "../../../project-memory-ui.js";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationIdentity,
  ManagedConversationLaunchOptions
} from "../../../ipc/managed-conversation-protocol.js";
import {
  selectionForInstance,
  selectionForAssignment,
  type ConversationSelection
} from "./ConversationSettings.js";
import {
  NewConversationComposer,
  type InitialConversationPrompt
} from "./NewConversationComposer.js";
import "./personal-memory.css";

const askTurnErrorMessage = (message: string | null): string =>
  message === "codex_failed"
    ? "This Ask failed before the Codex worker recorded a detailed reason."
    : (message ?? "Memory Answer failed.");

type ConversationStarted = (
  project: DesktopProject,
  conversation: ManagedConversationIdentity,
  status: "starting" | "ready",
  launch: Parameters<ManagedConversationDesktopApi["start"]>[0],
  initialPrompt?: InitialConversationPrompt
) => void;

export function PersonalAskView({
  api,
  managedConversations = null,
  localAiClients,
  markdownAdapters,
  onConversationStarted = () => undefined,
  onNew,
  onOpenProject,
  onResolveIndependent,
  projects = [],
  selectedThreadId
}: {
  api: PersonalDesktopApi;
  managedConversations?: ManagedConversationDesktopApi | null;
  localAiClients?: DesktopApi["localAiClients"];
  markdownAdapters: MarkdownPlatformAdapters;
  onConversationStarted?: ConversationStarted;
  onNew: () => void;
  onOpenProject?: () => Promise<DesktopProject | null>;
  onResolveIndependent?: () => Promise<DesktopProject | null>;
  onSelectThread?: (askThreadId: string) => void;
  projects?: readonly DesktopProject[];
  selectedThreadId?: string;
}) {
  const [turns, setTurns] = useState<PersonalDesktopAskTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launchOptions, setLaunchOptions] =
    useState<ManagedConversationLaunchOptions | null>(null);
  const [selection, setSelection] = useState<ConversationSelection>({
    instanceId: "",
    model: "",
    reasoningEffort: "",
    permissionMode: ""
  });
  const recentProjects = useMemo(
    () =>
      [...projects]
        .filter(
          (project) =>
            Boolean(project.path) &&
            project.contextKind !== "independent" &&
            project.name !== "Independent"
        )
        .sort(
          (left, right) =>
            Date.parse(projectLatestAt(right) ?? "0") -
              Date.parse(projectLatestAt(left) ?? "0") ||
            left.id.localeCompare(right.id)
        )
        .slice(0, 3),
    [projects]
  );
  const [launchPending, setLaunchPending] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  );
  const [openedProject, setOpenedProject] = useState<DesktopProject | null>(
    null
  );
  const [independentProject, setIndependentProject] =
    useState<DesktopProject | null>(null);
  const projectChoices = useMemo(
    () =>
      openedProject &&
      !recentProjects.some((project) => project.id === openedProject.id)
        ? [openedProject, ...recentProjects].slice(0, 3)
        : recentProjects,
    [openedProject, recentProjects]
  );
  const selectedProject =
    selectedProjectId === null
      ? independentProject
      : (projectChoices.find((project) => project.id === selectedProjectId) ??
        null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const resolveIndependentRef = useRef(onResolveIndependent);
  resolveIndependentRef.current = onResolveIndependent;

  useEffect(() => {
    if (!managedConversations || selectedThreadId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setLaunchOptions(null);
    const load = async () => {
      try {
        const [{ options }, settings] = await Promise.all([
          managedConversations.launchOptions(),
          localAiClients?.list()
        ]);
        if (!active) return;
        const assignment = settings
          ? assignmentFrom(settings.readModel, "conversations")
          : null;
        if (settings && !assignment)
          throw new Error("Conversations configuration is loading");
        const next = assignment
          ? selectionForAssignment(options, assignment)
          : selectionForInstance(
              options,
              options.instances.find((instance) => instance.ready)
                ?.instanceId ?? ""
            );
        const instance = options.instances.find(
          (instance) => instance.instanceId === next.instanceId
        );
        if (
          !instance?.ready ||
          !instance.models.some((model) => model.id === next.model) ||
          !next.permissionMode
        )
          throw new Error("Conversations capabilities are loading");
        setSelection(next);
        setLaunchOptions(options);
      } catch {
        if (active)
          timer = setTimeout(
            () => void load(),
            Math.min(500 * 2 ** attempts++, 5000)
          );
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [managedConversations, localAiClients, selectedThreadId]);

  useEffect(() => {
    if (selectedThreadId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      try {
        const project = await resolveIndependentRef.current?.();
        if (!active) return;
        if (!project) throw new Error("Chats project is loading");
        setIndependentProject(project);
      } catch {
        if (active)
          timer = setTimeout(
            () => void load(),
            Math.min(500 * 2 ** attempts++, 5000)
          );
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selectedThreadId]);

  useEffect(() => {
    headingRef.current?.focus();
    if (!selectedThreadId) {
      setTurns([]);
      setError(null);
      return;
    }
    let active = true;
    void api
      .loadAskThread?.({ askThreadId: selectedThreadId })
      .then((loaded) => {
        if (!active || !loaded) return;
        setTurns(loaded);
        setError(null);
      })
      .catch(() => {
        if (active) setError("This historical Ask thread could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [api, selectedThreadId]);

  if (selectedThreadId) {
    return (
      <div className="personal-ask-layout">
        <section className="personal-ask-main" data-view="conversation">
          <div className="personal-ask-conversation">
            <header className="personal-ask-conversation-heading">
              <span>Historical Ask</span>
              <button
                className="personal-new-conversation personal-new-conversation-standalone"
                onClick={onNew}
                type="button"
              >
                <Plus aria-hidden="true" /> New Conversation
              </button>
            </header>
            <div aria-live="polite" className="personal-ask-turns">
              {turns.map((turn) => (
                <article className="personal-ask-turn" key={turn.id}>
                  <p className="personal-ask-question">{turn.query}</p>
                  {turn.status === "pending" ? (
                    <p className="personal-ask-pending">
                      <LoaderCircle aria-hidden="true" /> Loading…
                    </p>
                  ) : turn.status === "error" ? (
                    <p className="personal-ask-error">
                      {askTurnErrorMessage(turn.errorMessage)}
                    </p>
                  ) : turn.answerMarkdown ? (
                    <SecureMarkdown
                      adapters={markdownAdapters}
                      className="personal-ask-answer"
                      source={turn.answerMarkdown}
                    />
                  ) : null}
                </article>
              ))}
            </div>
            <p className="personal-ask-history-note">
              This historical Ask is read-only. Start a new Conversation to
              continue.
            </p>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="personal-ask-layout">
      <section className="personal-ask-main" data-view="welcome">
        <div className="personal-agent-start">
          <h1 className="personal-route-heading" ref={headingRef} tabIndex={-1}>
            Where shall we start?
          </h1>
          <div
            aria-label="Conversation context"
            className="personal-agent-projects"
            role="group"
          >
            <button
              disabled={launchPending}
              aria-pressed={selectedProjectId === null}
              className={selectedProjectId === null ? "selected" : ""}
              onClick={() => setSelectedProjectId(null)}
              type="button"
            >
              <MessageSquare aria-hidden="true" />
              <strong>Chat</strong>
              <small>Start without a Project</small>
            </button>
            {projectChoices.map((project) => (
              <button
                disabled={launchPending}
                aria-pressed={selectedProjectId === project.id}
                className={selectedProjectId === project.id ? "selected" : ""}
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                type="button"
              >
                <Folder aria-hidden="true" />
                <strong>{project.name}</strong>
                <small>
                  {project.threads.length}{" "}
                  {project.threads.length === 1
                    ? "recent Conversation"
                    : "recent Conversations"}
                </small>
              </button>
            ))}
          </div>
          <button
            className="personal-agent-open-project"
            disabled={launchPending}
            onClick={() =>
              void onOpenProject?.()
                .then((project) => {
                  if (!project) return;
                  setOpenedProject(project);
                  setSelectedProjectId(project.id);
                  setError(null);
                })
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The Project could not be opened."
                  )
                )
            }
            type="button"
          >
            <Folder aria-hidden="true" /> Open a project
          </button>
          {error ? (
            <p className="personal-agent-project-error" role="alert">
              {error}
            </p>
          ) : null}
          <NewConversationComposer
            api={managedConversations}
            onPendingChange={setLaunchPending}
            contextKind={selectedProjectId === null ? "independent" : "project"}
            onChange={setSelection}
            onStarted={(conversation, status, launch, initialPrompt) =>
              selectedProject &&
              onConversationStarted(
                selectedProject,
                conversation,
                status,
                launch,
                initialPrompt
              )
            }
            options={launchOptions}
            placeholder={
              selectedProjectId === null
                ? "Ask a question or start a conversation…"
                : `Ask about ${selectedProject?.name ?? "this Project"}…`
            }
            projectId={selectedProject?.id ?? null}
            requirePrompt
            showContextHelp={false}
            selection={selection}
          />
        </div>
      </section>
    </div>
  );
}
