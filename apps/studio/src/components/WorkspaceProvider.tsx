"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  bootstrapProjectCollab,
  buildAgentReply,
  createEmptyWorkspace,
  createId,
  CURRENT_USER_ID,
  DEFAULT_THREAD_TITLE,
  hydrateThreads,
  moveThreadToProject,
  nextCheckInCount,
  parseWorkspace,
  titleFromPrompt,
  WORKSPACE_STORAGE_KEY,
  type ChatMessage,
  type Project,
  type Team,
  type Thread,
  type WorkspaceSnapshot
} from "@/lib/workspace";
import {
  generateAgentIdentity,
  chatChannel,
  resolveAgents,
  sameDmMembers,
  toggleReaction,
  type AgentAvatar,
  type AgentDefinition,
  type AgentStatus,
  type TokenBudget,
  type AgentWhisper,
  type ChannelMessage,
  type Channel,
  type Dm,
  type DmMessage,
  type ProjectAgent
} from "@/lib/collab";
import {
  applyChannelInviteDecision,
  applyChannelUserPost
} from "@/lib/channelCollab";
import type { CollabLanding } from "@/lib/home";
import {
  createMemoryItem,
  generateMemoryMeta,
  generateMemorySummary,
  randomFailureReason,
  FAILURE_RATE,
  INDEXING_MS,
  QUEUED_MS,
  type MemoryItem,
  type MemoryItemType
} from "@/lib/memoryInbox";

export type PersonalView = "home" | "chat";

type WorkspaceContextValue = {
  workspace: WorkspaceSnapshot;
  hydrated: boolean;
  previousSessionAt: number | null;
  // The timestamp this team was last active, from BEFORE this visit bumped
  // it - frozen at the moment you switch in, same idea as previousSessionAt
  // but per team, so "For you" can say "since you were last here".
  previousTeamVisitAt: number | null;
  activeThread: Thread | null;
  activeProject: Project | null;
  draftProject: Project | null;
  composerResetKey: number;
  personalView: PersonalView;
  collabLanding: CollabLanding | null;
  activeTeamId: string | null;
  activeTeam: Team | null;
  openHome: () => void;
  openCollaborative: (landing: CollabLanding) => void;
  clearCollabLanding: () => void;
  addProject: (input: {
    name: string;
    path: string;
    branch: string;
    githubRepo?: string;
    sharedWith: string[];
  }) => Project;
  renameProject: (projectId: string, name: string) => void;
  shareProject: (projectId: string, sharedWith: string[]) => void;
  startDraft: (projectId: string | null) => void;
  askKoed: (prompt: string, projectId?: string | null) => Thread;
  renameThread: (threadId: string, title: string) => void;
  shareThread: (threadId: string, sharedWith: string[]) => void;
  archiveThread: (threadId: string) => void;
  moveThread: (threadId: string, projectId: string | null) => void;
  setActiveThreadId: (threadId: string | null) => void;
  sendMessage: (text: string, threadId?: string | null) => Thread;
  setActiveTeamId: (teamId: string | null) => void;
  createChatChannel: (teamId: string, name: string) => Channel;
  postChannelMessage: (channelId: string, text: string) => ChannelMessage;
  postThreadReply: (
    channelId: string,
    rootId: string,
    text: string
  ) => ChannelMessage;
  postPrivateAgentAsk: (
    channelId: string,
    agentId: string,
    text: string
  ) => ChannelMessage;
  toggleChannelReaction: (messageId: string, emoji: string) => void;
  acceptChannelInvite: (inviteMessageId: string) => void;
  declineChannelInvite: (inviteMessageId: string) => void;
  editChannelMessage: (messageId: string, text: string) => void;
  setJobThreadNote: (threadId: string, note: string) => void;
  openDm: (teamId: string, memberIds: string[]) => Dm;
  postDmMessage: (dmId: string, text: string) => DmMessage;
  createAgentDefinition: (input: {
    name: string;
    role: string;
    avatar?: AgentAvatar;
  }) => AgentDefinition;
  unleashAgent: (input: {
    definitionId: string;
    projectId: string;
    model: string;
    effort: string;
    tokenBudget: TokenBudget;
  }) => ProjectAgent;
  updateAgentDefinition: (
    definitionId: string,
    input: {
      name: string;
      role: string;
      avatar?: AgentAvatar;
    }
  ) => AgentDefinition;
  deleteAgentDefinition: (definitionId: string) => void;
  setAgentStatus: (agentId: string, status: AgentStatus, focus: string) => void;
  requestMemoryCheck: (channelMessageId: string) => AgentWhisper;
  markWhisperRead: (whisperId: string) => void;
  markDmRead: (dmId: string) => void;
  addMemoryItem: (input: {
    type: MemoryItemType;
    title: string;
    source: string;
    tags: string[];
  }) => MemoryItem;
  retryMemoryItem: (itemId: string) => void;
  shareMemoryItem: (itemId: string, sharedWith: string[]) => void;
  deleteMemoryItem: (itemId: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(
  undefined
);

function writeWorkspace(snapshot: WorkspaceSnapshot) {
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspace, setWorkspace] =
    useState<WorkspaceSnapshot>(createEmptyWorkspace);
  const [hydrated, setHydrated] = useState(false);
  const [previousSessionAt, setPreviousSessionAt] = useState<number | null>(
    null
  );
  const [previousTeamVisitAt, setPreviousTeamVisitAt] = useState<number | null>(
    null
  );
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [personalView, setPersonalView] = useState<PersonalView>("home");
  const [collabLanding, setCollabLanding] = useState<CollabLanding | null>(
    null
  );
  const [activeTeamId, setActiveTeamIdState] = useState<string | null>(null);
  const draftProjectIdRef = useRef<string | null>(null);
  const sessionMarked = useRef(false);

  const assignDraftProjectId = useCallback((projectId: string | null) => {
    draftProjectIdRef.current = projectId;
    setDraftProjectId(projectId);
  }, []);

  useEffect(() => {
    const loaded = parseWorkspace(
      window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    );
    // Restore the last-session timestamp from browser storage after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviousSessionAt(loaded.lastSessionAt);
    const now = Date.now();
    const next = { ...loaded, lastSessionAt: now, activeThreadId: null };
    setWorkspace(next);
    writeWorkspace(next);
    sessionMarked.current = true;
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !sessionMarked.current) return;
    writeWorkspace(workspace);
  }, [hydrated, workspace]);

  const updateWorkspace = useCallback(
    (updater: (current: WorkspaceSnapshot) => WorkspaceSnapshot) => {
      setWorkspace((current) => updater(current));
    },
    []
  );

  const addProject = useCallback(
    (input: {
      name: string;
      path: string;
      branch: string;
      githubRepo?: string;
      sharedWith: string[];
    }) => {
      const project: Project = {
        id: createId("project"),
        name: input.name,
        path: input.path,
        branch: input.branch,
        githubRepo: input.githubRepo,
        gitStatus: "clean",
        sharedWith: input.sharedWith,
        createdAt: Date.now()
      };
      updateWorkspace((current) => {
        const boot = bootstrapProjectCollab(project, current.teams);
        return {
          ...current,
          projects: [...current.projects, project],
          channels: [...current.channels, ...boot.channels],
          agentDefinitions: [...current.agentDefinitions, ...boot.definitions],
          projectAgents: [...current.projectAgents, ...boot.agents]
        };
      });
      return project;
    },
    [updateWorkspace]
  );

  const renameProject = useCallback(
    (projectId: string, name: string) => {
      updateWorkspace((current) => ({
        ...current,
        projects: current.projects.map((project) =>
          project.id === projectId ? { ...project, name } : project
        )
      }));
    },
    [updateWorkspace]
  );

  const shareProject = useCallback(
    (projectId: string, sharedWith: string[]) => {
      updateWorkspace((current) => {
        const existing = current.projects.find(
          (project) => project.id === projectId
        );
        if (!existing) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        const project = { ...existing, sharedWith };
        const boot = bootstrapProjectCollab(project, current.teams);
        const existingChannelTeamIds = new Set(
          current.channels
            .filter((channel) => channel.projectId === projectId)
            .map((channel) => channel.teamId)
        );
        const missingChannels = boot.channels.filter(
          (channel) => !existingChannelTeamIds.has(channel.teamId)
        );
        const nextAgents = [...current.projectAgents];
        const nextDefinitions = [...current.agentDefinitions];
        boot.agents.forEach((agent, index) => {
          if (
            nextAgents.some(
              (item) =>
                item.projectId === projectId && item.ownerId === agent.ownerId
            )
          )
            return;
          nextAgents.push(agent);
          nextDefinitions.push(boot.definitions[index]);
        });
        return {
          ...current,
          projects: current.projects.map((item) =>
            item.id === projectId ? project : item
          ),
          channels: [...current.channels, ...missingChannels],
          agentDefinitions: nextDefinitions,
          projectAgents: nextAgents
        };
      });
    },
    [updateWorkspace]
  );

  const startDraft = useCallback(
    (projectId: string | null) => {
      if (projectId) {
        const project = workspace.projects.find(
          (item) => item.id === projectId
        );
        if (!project) {
          throw new Error(`Unknown project: ${projectId}`);
        }
      }
      setPersonalView("chat");
      setCollabLanding(null);
      setActiveTeamIdState(null);
      assignDraftProjectId(projectId);
      setComposerResetKey((current) => current + 1);
      updateWorkspace((current) => ({
        ...current,
        threads: hydrateThreads(current.threads),
        activeThreadId: null
      }));
    },
    [assignDraftProjectId, updateWorkspace, workspace.projects]
  );

  const renameThread = useCallback(
    (threadId: string, title: string) => {
      updateWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, title, updatedAt: Date.now() }
            : thread
        )
      }));
    },
    [updateWorkspace]
  );

  const shareThread = useCallback(
    (threadId: string, sharedWith: string[]) => {
      updateWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) =>
          thread.id === threadId ? { ...thread, sharedWith } : thread
        )
      }));
    },
    [updateWorkspace]
  );

  const archiveThread = useCallback(
    (threadId: string) => {
      updateWorkspace((current) => {
        const remaining = current.threads.filter(
          (thread) => thread.id !== threadId
        );
        const wasActive = current.activeThreadId === threadId;
        if (wasActive) {
          setPersonalView("home");
          assignDraftProjectId(null);
        }
        return {
          ...current,
          threads: remaining,
          activeThreadId: wasActive ? null : current.activeThreadId
        };
      });
    },
    [assignDraftProjectId, updateWorkspace]
  );

  const setActiveThreadId = useCallback(
    (threadId: string | null) => {
      setPersonalView("chat");
      setCollabLanding(null);
      setActiveTeamIdState(null);
      assignDraftProjectId(null);
      updateWorkspace((current) => ({
        ...current,
        activeThreadId: threadId
      }));
    },
    [assignDraftProjectId, updateWorkspace]
  );

  const moveThread = useCallback(
    (threadId: string, projectId: string | null) => {
      if (
        projectId &&
        !workspace.projects.some((project) => project.id === projectId)
      ) {
        throw new Error(`Unknown project: ${projectId}`);
      }
      updateWorkspace((current) => ({
        ...current,
        threads: moveThreadToProject(current.threads, threadId, projectId)
      }));
    },
    [updateWorkspace, workspace.projects]
  );

  const sendMessage = useCallback(
    (text: string, threadId?: string | null) => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Cannot send an empty message");
      }

      const now = Date.now();
      const targetId = threadId ?? workspace.activeThreadId;
      const existing = workspace.threads.find(
        (thread) => thread.id === targetId
      );
      const thread =
        existing ??
        ({
          id: createId("thread"),
          title: DEFAULT_THREAD_TITLE,
          projectId: draftProjectIdRef.current,
          messages: [],
          sharedWith: [],
          createdAt: now,
          updatedAt: now
        } satisfies Thread);

      const userMessage: ChatMessage = {
        id: createId("msg"),
        role: "user",
        content: trimmed,
        createdAt: now
      };
      const agentMessage: ChatMessage = {
        id: createId("msg"),
        role: "agent",
        content: buildAgentReply(trimmed, workspace),
        createdAt: now + 1
      };
      const title =
        thread.messages.length === 0
          ? titleFromPrompt(trimmed)
          : thread.title === DEFAULT_THREAD_TITLE
            ? titleFromPrompt(
                thread.messages.find((message) => message.role === "user")
                  ?.content ?? trimmed
              )
            : thread.title;
      const nextThread: Thread = {
        ...thread,
        title,
        messages: [...thread.messages, userMessage, agentMessage],
        updatedAt: now
      };

      setPersonalView("chat");
      assignDraftProjectId(null);
      updateWorkspace((current) => {
        const threads = current.threads.some(
          (item) => item.id === nextThread.id
        )
          ? current.threads.map((item) =>
              item.id === nextThread.id ? nextThread : item
            )
          : [nextThread, ...current.threads];
        return {
          ...current,
          threads,
          activeThreadId: nextThread.id
        };
      });
      return nextThread;
    },
    [assignDraftProjectId, updateWorkspace, workspace]
  );

  const askKoed = useCallback(
    (prompt: string, projectId: string | null = null) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        throw new Error("Cannot send an empty message");
      }
      if (
        projectId &&
        !workspace.projects.some((project) => project.id === projectId)
      ) {
        throw new Error(`Unknown project: ${projectId}`);
      }
      const now = Date.now();
      const userMessage: ChatMessage = {
        id: createId("msg"),
        role: "user",
        content: trimmed,
        createdAt: now
      };
      const agentMessage: ChatMessage = {
        id: createId("msg"),
        role: "agent",
        content: buildAgentReply(trimmed, workspace),
        createdAt: now + 1
      };
      const thread: Thread = {
        id: createId("thread"),
        title: titleFromPrompt(trimmed),
        projectId,
        messages: [userMessage, agentMessage],
        sharedWith: [],
        createdAt: now,
        updatedAt: now
      };
      setPersonalView("chat");
      setCollabLanding(null);
      setActiveTeamIdState(null);
      assignDraftProjectId(null);
      updateWorkspace((current) => ({
        ...current,
        threads: [thread, ...hydrateThreads(current.threads)],
        activeThreadId: thread.id
      }));
      return thread;
    },
    [assignDraftProjectId, updateWorkspace, workspace]
  );

  // Records "you're here now", but returns what the team's last visit WAS
  // right before this one - that's the number "For you"'s recap actually
  // needs, and it has to be captured before this call overwrites it.
  const stampTeamVisit = useCallback(
    (teamId: string) => {
      setPreviousTeamVisitAt(workspace.teamVisits[teamId] ?? null);
      updateWorkspace((current) => ({
        ...current,
        teamVisits: { ...current.teamVisits, [teamId]: Date.now() },
        teamCheckIns: {
          ...current.teamCheckIns,
          [teamId]: nextCheckInCount(current.teamCheckIns[teamId])
        }
      }));
    },
    [updateWorkspace, workspace.teamVisits]
  );

  const setActiveTeamId = useCallback(
    (teamId: string | null) => {
      if (teamId && !workspace.teams.some((team) => team.id === teamId)) {
        throw new Error(`Unknown team: ${teamId}`);
      }
      setCollabLanding(null);
      setActiveTeamIdState(teamId);
      if (teamId) {
        stampTeamVisit(teamId);
      } else {
        setPreviousTeamVisitAt(null);
      }
    },
    [stampTeamVisit, workspace.teams]
  );

  const openHome = useCallback(() => {
    setPersonalView("home");
    setCollabLanding(null);
    setActiveTeamIdState(null);
    assignDraftProjectId(null);
    updateWorkspace((current) => ({
      ...current,
      activeThreadId: null
    }));
  }, [assignDraftProjectId, updateWorkspace]);

  const openCollaborative = useCallback(
    (landing: CollabLanding) => {
      if (!workspace.teams.some((team) => team.id === landing.teamId)) {
        throw new Error(`Unknown team: ${landing.teamId}`);
      }
      if (
        landing.projectId &&
        !workspace.projects.some((project) => project.id === landing.projectId)
      ) {
        throw new Error(`Unknown project: ${landing.projectId}`);
      }
      setPersonalView("home");
      assignDraftProjectId(null);
      updateWorkspace((current) => ({
        ...current,
        activeThreadId: null
      }));
      setCollabLanding(landing);
      setActiveTeamIdState(landing.teamId);
      stampTeamVisit(landing.teamId);
    },
    [
      assignDraftProjectId,
      stampTeamVisit,
      updateWorkspace,
      workspace.projects,
      workspace.teams
    ]
  );

  const clearCollabLanding = useCallback(() => {
    setCollabLanding(null);
  }, []);

  const postChannelMessage = useCallback(
    (channelId: string, text: string) => {
      let posted: ChannelMessage | null = null;
      updateWorkspace((current) => {
        const next = applyChannelUserPost(current, channelId, text);
        posted = next.userMessage;
        return {
          ...current,
          channelMessages: next.channelMessages,
          channelCollabs: next.channelCollabs,
          channelJobThreads: next.channelJobThreads
        };
      });
      if (!posted) {
        throw new Error("Failed to post channel message");
      }
      return posted;
    },
    [updateWorkspace]
  );

  // Studio's current team workspace model is browser-local preview state.
  const createChatChannel = useCallback(
    (teamId: string, name: string) => {
      const channel = chatChannel(teamId, name);
      if (!channel.name) throw new Error("Channel name is required");
      updateWorkspace((current) => {
        if (!current.teams.some((team) => team.id === teamId))
          throw new Error(`Unknown team: ${teamId}`);
        if (
          current.channels.some(
            (item) =>
              item.teamId === teamId && item.name.toLowerCase() === channel.name
          )
        ) {
          throw new Error(`Channel already exists: #${channel.name}`);
        }
        return { ...current, channels: [...current.channels, channel] };
      });
      return channel;
    },
    [updateWorkspace]
  );

  const postThreadReply = useCallback(
    (channelId: string, rootId: string, text: string) => {
      const content = text.trim();
      if (!content) throw new Error("Cannot post an empty thread reply");
      const reply: ChannelMessage = {
        id: createId("cmsg"),
        channelId,
        authorId: CURRENT_USER_ID,
        content,
        createdAt: Date.now(),
        kind: "chat",
        authorKind: "human",
        threadRootId: rootId
      };
      updateWorkspace((current) => {
        const root = current.channelMessages.find(
          (message) => message.id === rootId && message.channelId === channelId
        );
        if (!root || root.threadRootId)
          throw new Error("Unknown channel thread");
        return {
          ...current,
          channelMessages: [...current.channelMessages, reply]
        };
      });
      return reply;
    },
    [updateWorkspace]
  );

  // Store the question as a browser-local private preview item. This does
  // not invoke an agent or provide server-side privacy enforcement.
  const postPrivateAgentAsk = useCallback(
    (channelId: string, agentId: string, text: string) => {
      const content = text.trim();
      if (!content) throw new Error("Cannot post an empty private question");
      const message: ChannelMessage = {
        id: createId("cmsg"),
        channelId,
        authorId: CURRENT_USER_ID,
        content,
        createdAt: Date.now(),
        kind: "chat",
        authorKind: "human",
        visibility: "private",
        recipientAgentId: agentId
      };
      updateWorkspace((current) => {
        const channel = current.channels.find((item) => item.id === channelId);
        if (!channel) throw new Error(`Unknown channel: ${channelId}`);
        const agents = resolveAgents(
          current.projectAgents,
          current.agentDefinitions
        );
        const isAvailable = channel.projectId
          ? agents.some(
              (agent) =>
                agent.id === agentId && agent.projectId === channel.projectId
            )
          : (() => {
              const teamProjectIds = new Set(
                current.projects
                  .filter((project) =>
                    project.sharedWith.includes(channel.teamId)
                  )
                  .map((project) => project.id)
              );
              return agents.some(
                (agent) =>
                  agent.id === agentId && teamProjectIds.has(agent.projectId)
              );
            })();
        if (!isAvailable) throw new Error(`Unknown agent: ${agentId}`);
        return {
          ...current,
          channelMessages: [...current.channelMessages, message]
        };
      });
      return message;
    },
    [updateWorkspace]
  );

  const toggleChannelReaction = useCallback(
    (messageId: string, emoji: string) => {
      updateWorkspace((current) => ({
        ...current,
        channelMessages: current.channelMessages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                reactions: toggleReaction(
                  message.reactions,
                  emoji,
                  CURRENT_USER_ID
                )
              }
            : message
        )
      }));
    },
    [updateWorkspace]
  );

  const acceptChannelInvite = useCallback(
    (inviteMessageId: string) => {
      updateWorkspace((current) => {
        const next = applyChannelInviteDecision(
          current,
          inviteMessageId,
          "accepted"
        );
        return {
          ...current,
          channelMessages: next.channelMessages,
          channelCollabs: next.channelCollabs,
          channelJobThreads: next.channelJobThreads
        };
      });
    },
    [updateWorkspace]
  );

  const declineChannelInvite = useCallback(
    (inviteMessageId: string) => {
      updateWorkspace((current) => {
        const next = applyChannelInviteDecision(
          current,
          inviteMessageId,
          "declined"
        );
        return {
          ...current,
          channelMessages: next.channelMessages,
          channelCollabs: next.channelCollabs,
          channelJobThreads: next.channelJobThreads
        };
      });
    },
    [updateWorkspace]
  );

  // A private reaction the owner leaves on a finished job - never posted to
  // the channel, just for them (and the agent's history) to look back on.
  const setJobThreadNote = useCallback(
    (threadId: string, note: string) => {
      updateWorkspace((current) => ({
        ...current,
        channelJobThreads: current.channelJobThreads.map((thread) =>
          thread.id === threadId ? { ...thread, note } : thread
        )
      }));
    },
    [updateWorkspace]
  );

  const editChannelMessage = useCallback(
    (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Cannot save an empty channel message");
      }
      updateWorkspace((current) => ({
        ...current,
        channelMessages: current.channelMessages.map((message) =>
          message.id === messageId
            ? { ...message, content: trimmed, editedAt: Date.now() }
            : message
        )
      }));
    },
    [updateWorkspace]
  );

  const openDm = useCallback(
    (teamId: string, memberIds: string[]) => {
      const uniqueIds = Array.from(new Set([CURRENT_USER_ID, ...memberIds]));
      if (uniqueIds.length < 2) {
        throw new Error("A direct message needs at least one other person");
      }
      let result: Dm | null = null;
      updateWorkspace((current) => {
        if (!current.teams.some((team) => team.id === teamId)) {
          throw new Error(`Unknown team: ${teamId}`);
        }
        const existing = current.dms.find(
          (dm) => dm.teamId === teamId && sameDmMembers(dm.memberIds, uniqueIds)
        );
        if (existing) {
          result = existing;
          return current;
        }
        const dm: Dm = { id: createId("dm"), teamId, memberIds: uniqueIds };
        result = dm;
        return { ...current, dms: [...current.dms, dm] };
      });
      if (!result) {
        throw new Error("Failed to open a direct message");
      }
      return result;
    },
    [updateWorkspace]
  );

  const postDmMessage = useCallback(
    (dmId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Cannot post an empty direct message");
      }
      const message: DmMessage = {
        id: createId("dmsg"),
        dmId,
        authorId: CURRENT_USER_ID,
        content: trimmed,
        createdAt: Date.now()
      };
      updateWorkspace((current) => {
        if (!current.dms.some((dm) => dm.id === dmId)) {
          throw new Error(`Unknown conversation: ${dmId}`);
        }
        return { ...current, dmMessages: [...current.dmMessages, message] };
      });
      return message;
    },
    [updateWorkspace]
  );

  // Create a reusable agent identity on the Personal side. Not tied to any
  // project - use unleashAgent to put it to work somewhere.
  const createAgentDefinition = useCallback(
    (input: { name: string; role: string; avatar?: AgentAvatar }) => {
      const name = input.name.trim();
      const role = input.role.trim();
      if (!name) {
        throw new Error("Agent name is required");
      }
      if (!role) {
        throw new Error("Agent role is required");
      }
      const definition: AgentDefinition = {
        id: createId("agentdef"),
        ownerId: CURRENT_USER_ID,
        name,
        role,
        identity: generateAgentIdentity({ name, role }),
        createdAt: Date.now(),
        ...(input.avatar ? { avatar: input.avatar } : {})
      };
      updateWorkspace((current) => ({
        ...current,
        agentDefinitions: [definition, ...current.agentDefinitions]
      }));
      return definition;
    },
    [updateWorkspace]
  );

  // Put an existing agent definition to work in a project. This is what
  // "unleash" means now - the agent's identity already exists, this just
  // creates its engagement here, with its own model/effort/token budget.
  // The same definition can be unleashed elsewhere with completely
  // different runtime settings - that's the whole point.
  const unleashAgent = useCallback(
    (input: {
      definitionId: string;
      projectId: string;
      model: string;
      effort: string;
      tokenBudget: TokenBudget;
    }) => {
      const definition = workspace.agentDefinitions.find(
        (item) => item.id === input.definitionId
      );
      if (!definition) {
        throw new Error(`Unknown agent: ${input.definitionId}`);
      }
      const project = workspace.projects.find(
        (item) => item.id === input.projectId
      );
      if (!project) {
        throw new Error(`Unknown project: ${input.projectId}`);
      }
      const alreadyUnleashed = workspace.projectAgents.some(
        (item) =>
          item.definitionId === input.definitionId &&
          item.projectId === input.projectId
      );
      if (alreadyUnleashed) {
        throw new Error(
          `${definition.name} is already unleashed in ${project.name}`
        );
      }
      const agent: ProjectAgent = {
        id: createId("agent"),
        definitionId: definition.id,
        projectId: input.projectId,
        ownerId: definition.ownerId,
        status: "idle",
        focus: "No active job",
        model: input.model,
        effort: input.effort,
        tokenBudget: input.tokenBudget,
        createdAt: Date.now()
      };
      updateWorkspace((current) => ({
        ...current,
        projectAgents: [agent, ...current.projectAgents],
        agentEvents: [
          {
            id: createId("aev"),
            agentId: agent.id,
            at: Date.now(),
            label: `Unleashed ${definition.name} (${definition.role}) into ${project.name}.`
          },
          ...current.agentEvents
        ]
      }));
      return agent;
    },
    [
      updateWorkspace,
      workspace.agentDefinitions,
      workspace.projectAgents,
      workspace.projects
    ]
  );

  // Edit an existing agent's reusable identity. Regenerates its soul.md
  // identity block from the new fields; per-project engagements (and their
  // live context briefs) are unaffected since those are derived separately.
  const updateAgentDefinition = useCallback(
    (
      definitionId: string,
      input: { name: string; role: string; avatar?: AgentAvatar }
    ) => {
      const name = input.name.trim();
      const role = input.role.trim();
      if (!name) {
        throw new Error("Agent name is required");
      }
      if (!role) {
        throw new Error("Agent role is required");
      }
      let updated: AgentDefinition | null = null;
      updateWorkspace((current) => {
        const existing = current.agentDefinitions.find(
          (item) => item.id === definitionId
        );
        if (!existing) {
          throw new Error(`Unknown agent: ${definitionId}`);
        }
        updated = {
          ...existing,
          name,
          role,
          identity: generateAgentIdentity({ name, role }),
          ...(input.avatar ? { avatar: input.avatar } : {})
        };
        return {
          ...current,
          agentDefinitions: current.agentDefinitions.map((item) =>
            item.id === definitionId ? (updated as AgentDefinition) : item
          )
        };
      });
      if (!updated) {
        throw new Error(`Unknown agent: ${definitionId}`);
      }
      return updated;
    },
    [updateWorkspace]
  );

  // Delete a reusable agent identity. It can't be left dangling in projects
  // it was unleashed into, so those engagements are removed too - the agent
  // disappears from every project at once, same as it could appear in more
  // than one at once.
  const deleteAgentDefinition = useCallback(
    (definitionId: string) => {
      updateWorkspace((current) => {
        const existing = current.agentDefinitions.find(
          (item) => item.id === definitionId
        );
        if (!existing) {
          throw new Error(`Unknown agent: ${definitionId}`);
        }
        return {
          ...current,
          agentDefinitions: current.agentDefinitions.filter(
            (item) => item.id !== definitionId
          ),
          projectAgents: current.projectAgents.filter(
            (item) => item.definitionId !== definitionId
          )
        };
      });
    },
    [updateWorkspace]
  );

  const setAgentStatus = useCallback(
    (agentId: string, status: AgentStatus, focus: string) => {
      updateWorkspace((current) => {
        const agent = current.projectAgents.find((item) => item.id === agentId);
        if (!agent) {
          throw new Error(`Unknown agent: ${agentId}`);
        }
        const agentName =
          current.agentDefinitions.find(
            (item) => item.id === agent.definitionId
          )?.name ?? "Agent";
        const nextFocus = focus.trim() || agent.focus;
        const whispers =
          status === "waiting" && agent.ownerId === CURRENT_USER_ID
            ? [
                {
                  id: createId("whisper"),
                  agentId,
                  recipientId: CURRENT_USER_ID,
                  kind: "blocker" as const,
                  title: `${agentName} is blocked`,
                  body: nextFocus,
                  provenance: [
                    {
                      title: "Workshop",
                      detail:
                        "This ping is private. The team can see that the agent is waiting, not this message."
                    }
                  ],
                  createdAt: Date.now(),
                  read: false
                },
                ...current.whispers
              ]
            : current.whispers;
        return {
          ...current,
          projectAgents: current.projectAgents.map((item) =>
            item.id === agentId ? { ...item, status, focus: nextFocus } : item
          ),
          agentEvents: [
            {
              id: createId("aev"),
              agentId,
              at: Date.now(),
              label:
                status === "running"
                  ? `Started work: ${nextFocus}`
                  : status === "waiting"
                    ? `Waiting on owner: ${nextFocus}`
                    : "Paused. Idle."
            },
            ...current.agentEvents
          ],
          whispers
        };
      });
    },
    [updateWorkspace]
  );

  const requestMemoryCheck = useCallback(
    (channelMessageId: string) => {
      let created: AgentWhisper | null = null;
      updateWorkspace((current) => {
        const message = current.channelMessages.find(
          (item) => item.id === channelMessageId
        );
        if (!message) {
          throw new Error(`Unknown message: ${channelMessageId}`);
        }
        if (message.authorId !== CURRENT_USER_ID) {
          throw new Error(
            "Memory checks are only private to your own messages"
          );
        }
        const channel = current.channels.find(
          (item) => item.id === message.channelId
        );
        if (!channel) {
          throw new Error("Unknown channel");
        }
        // A project channel's memory check looks for your own agent on that
        // one project. A team-wide channel (like #general) has no single
        // project, so it looks across every project shared with the team.
        const teamProjectIds = new Set(
          current.projects
            .filter((item) => item.sharedWith.includes(channel.teamId))
            .map((item) => item.id)
        );
        const agent = current.projectAgents.find(
          (item) =>
            item.ownerId === CURRENT_USER_ID &&
            (channel.projectId
              ? item.projectId === channel.projectId
              : teamProjectIds.has(item.projectId))
        );
        if (!agent) {
          throw new Error(
            "Unleash an agent in this project before requesting a memory check"
          );
        }
        const agentName =
          current.agentDefinitions.find(
            (item) => item.id === agent.definitionId
          )?.name ?? "Agent";
        const project = current.projects.find(
          (item) => item.id === agent.projectId
        );
        const provenance = [
          {
            title: "Koed Memory",
            detail:
              "Private check against this project's shared memory. The team does not see this whisper."
          }
        ];
        if (project) {
          provenance.push({
            title: project.name,
            detail: `${project.path} on ${project.branch}`
          });
        }
        if (current.pullRequests[0]) {
          const pullRequest = current.pullRequests[0];
          provenance.push({
            title: pullRequest.title,
            detail: `${pullRequest.repo} (${pullRequest.baseBranch} › ${pullRequest.branch})`
          });
        }
        const whisper: AgentWhisper = {
          id: createId("whisper"),
          agentId: agent.id,
          recipientId: CURRENT_USER_ID,
          kind: "correction",
          title: `${agentName} checked your message`,
          body: current.pullRequests.length
            ? `Memory has review context that may not match what you just said. Edit the message in the channel if you want the team record to change.`
            : `No review record contradicts this yet. If you still want to rephrase it for the team, edit the message yourself.`,
          provenance,
          channelMessageId: message.id,
          createdAt: Date.now(),
          read: false
        };
        created = whisper;
        return { ...current, whispers: [whisper, ...current.whispers] };
      });
      if (!created) {
        throw new Error("Failed to create a memory check");
      }
      return created;
    },
    [updateWorkspace]
  );

  const markWhisperRead = useCallback(
    (whisperId: string) => {
      updateWorkspace((current) => ({
        ...current,
        whispers: current.whispers.map((whisper) =>
          whisper.id === whisperId ? { ...whisper, read: true } : whisper
        )
      }));
    },
    [updateWorkspace]
  );

  // Stamps "you looked at this DM just now" - the same idea as
  // stampTeamVisit, just per conversation instead of per team, so For
  // you's Direct messages section can tell an unread reply from one
  // you've already opened.
  const markDmRead = useCallback(
    (dmId: string) => {
      updateWorkspace((current) => ({
        ...current,
        dmReadAt: { ...current.dmReadAt, [dmId]: Date.now() }
      }));
    },
    [updateWorkspace]
  );

  // Drop a link or file into the Memory Inbox. It starts Queued - the
  // ticking effect below carries it through Indexing to Ready (or,
  // occasionally, Failed) on its own, the same way a real ingestion job
  // would run in the background.
  const addMemoryItem = useCallback(
    (input: {
      type: MemoryItemType;
      title: string;
      source: string;
      tags: string[];
    }) => {
      const title = input.title.trim();
      if (!title) {
        throw new Error("A title is required");
      }
      const item = createMemoryItem({
        ownerId: CURRENT_USER_ID,
        type: input.type,
        title,
        source: input.source,
        tags: input.tags
      });
      updateWorkspace((current) => ({
        ...current,
        memoryItems: [item, ...current.memoryItems]
      }));
      return item;
    },
    [updateWorkspace]
  );

  // Send a Failed item back through the pipeline from the top.
  const retryMemoryItem = useCallback(
    (itemId: string) => {
      updateWorkspace((current) => ({
        ...current,
        memoryItems: current.memoryItems.map((item) =>
          item.id === itemId
            ? {
                ...item,
                status: "queued" as const,
                statusChangedAt: Date.now(),
                failureReason: undefined
              }
            : item
        )
      }));
    },
    [updateWorkspace]
  );

  const shareMemoryItem = useCallback(
    (itemId: string, sharedWith: string[]) => {
      updateWorkspace((current) => ({
        ...current,
        memoryItems: current.memoryItems.map((item) =>
          item.id === itemId ? { ...item, sharedWith } : item
        )
      }));
    },
    [updateWorkspace]
  );

  const deleteMemoryItem = useCallback(
    (itemId: string) => {
      updateWorkspace((current) => ({
        ...current,
        memoryItems: current.memoryItems.filter((item) => item.id !== itemId)
      }));
    },
    [updateWorkspace]
  );

  // The Memory Inbox's ingestion pipeline. A single interval, checked
  // against each item's own statusChangedAt, advances anything that's
  // been Queued or Indexing long enough - functional updateWorkspace
  // always sees the latest state, so this needs no dependency on
  // workspace.memoryItems itself and never double-schedules anything.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      updateWorkspace((current) => {
        let changed = false;
        const memoryItems = current.memoryItems.map((item) => {
          if (
            item.status === "queued" &&
            now - item.statusChangedAt >= QUEUED_MS
          ) {
            changed = true;
            return {
              ...item,
              status: "indexing" as const,
              statusChangedAt: now
            };
          }
          if (
            item.status === "indexing" &&
            now - item.statusChangedAt >= INDEXING_MS
          ) {
            changed = true;
            if (Math.random() < FAILURE_RATE) {
              return {
                ...item,
                status: "failed" as const,
                statusChangedAt: now,
                failureReason: randomFailureReason(item.type)
              };
            }
            return {
              ...item,
              status: "ready" as const,
              statusChangedAt: now,
              summary: generateMemorySummary(item),
              meta: generateMemoryMeta(item)
            };
          }
          return item;
        });
        if (!changed) return current;
        return { ...current, memoryItems };
      });
    }, 700);
    return () => window.clearInterval(interval);
  }, [updateWorkspace]);

  const activeThread = useMemo(
    () =>
      workspace.threads.find(
        (thread) => thread.id === workspace.activeThreadId
      ) ?? null,
    [workspace.activeThreadId, workspace.threads]
  );
  const activeProject = useMemo(
    () =>
      workspace.projects.find(
        (project) => project.id === activeThread?.projectId
      ) ?? null,
    [activeThread?.projectId, workspace.projects]
  );
  const draftProject = useMemo(
    () =>
      workspace.projects.find((project) => project.id === draftProjectId) ??
      null,
    [draftProjectId, workspace.projects]
  );
  const activeTeam = useMemo(
    () => workspace.teams.find((team) => team.id === activeTeamId) ?? null,
    [activeTeamId, workspace.teams]
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace,
      hydrated,
      previousSessionAt,
      previousTeamVisitAt,
      activeThread,
      activeProject,
      draftProject,
      composerResetKey,
      personalView,
      collabLanding,
      activeTeamId,
      activeTeam,
      openHome,
      openCollaborative,
      clearCollabLanding,
      addProject,
      renameProject,
      shareProject,
      startDraft,
      askKoed,
      renameThread,
      shareThread,
      archiveThread,
      moveThread,
      setActiveThreadId,
      sendMessage,
      setActiveTeamId,
      createChatChannel,
      postChannelMessage,
      postThreadReply,
      postPrivateAgentAsk,
      toggleChannelReaction,
      acceptChannelInvite,
      declineChannelInvite,
      editChannelMessage,
      setJobThreadNote,
      openDm,
      postDmMessage,
      createAgentDefinition,
      unleashAgent,
      updateAgentDefinition,
      deleteAgentDefinition,
      setAgentStatus,
      requestMemoryCheck,
      markWhisperRead,
      markDmRead,
      addMemoryItem,
      retryMemoryItem,
      shareMemoryItem,
      deleteMemoryItem
    }),
    [
      activeProject,
      activeTeam,
      activeTeamId,
      activeThread,
      acceptChannelInvite,
      addProject,
      archiveThread,
      askKoed,
      clearCollabLanding,
      collabLanding,
      composerResetKey,
      createAgentDefinition,
      createChatChannel,
      declineChannelInvite,
      draftProject,
      editChannelMessage,
      hydrated,
      markWhisperRead,
      markDmRead,
      moveThread,
      openCollaborative,
      openDm,
      openHome,
      personalView,
      postChannelMessage,
      postThreadReply,
      postPrivateAgentAsk,
      toggleChannelReaction,
      postDmMessage,
      previousSessionAt,
      previousTeamVisitAt,
      setJobThreadNote,
      renameProject,
      renameThread,
      requestMemoryCheck,
      sendMessage,
      setActiveTeamId,
      setActiveThreadId,
      setAgentStatus,
      shareProject,
      unleashAgent,
      updateAgentDefinition,
      deleteAgentDefinition,
      shareThread,
      startDraft,
      workspace,
      addMemoryItem,
      retryMemoryItem,
      shareMemoryItem,
      deleteMemoryItem
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
