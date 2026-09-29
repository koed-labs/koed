import type { BrowserWindowConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationActionGrantIntentSchema,
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationSnapshotSchema,
  collaborationThreadSchema,
  collaborationRendererEventSchema,
  sharedMemorySourceRefSchema,
  type CollaborationSnapshot,
  type CollaborationRendererCommand,
  type CollaborationCommandResult,
  type CollaborationRendererEvent,
  type CollaborationActionGrantReference,
  type CollaborationApprovalReview
} from "@koed/shared";
import type { DesktopCommandContext } from "../koed-server/manager.js";
import { desktopRendererOrigin } from "../ipc/protocol.js";

export interface StudioCollaborationSnapshot {
  connection: CollaborationSnapshot["connection"];
  teams: Array<{
    id: string;
    name: string;
    role: CollaborationSnapshot["navigation"]["teams"][number]["role"];
    unreadCount: number;
    people: Array<{ id: string; displayName: string }>;
    workspaces: Array<{ id: string; name: string }>;
  }>;
  error?: string;
}

export interface StudioLocalAccess {
  apiOrigin: string;
  apiToken: string;
}

export interface StudioWindowLike {
  webContents: {
    setWindowOpenHandler(
      handler: (details: { url: string }) => { action: "allow" | "deny" }
    ): void;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }, url: string) => void
    ): void;
  };
  once(event: "closed", listener: () => void): this;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
}

export interface StudioGateway {
  url: string;
  close(): Promise<void>;
}

export interface StudioTeamDraftAuthority {
  backendId: string;
  principalUserId: string;
  teamId: string;
  threadId: string;
}
export interface StudioTeamDraft {
  text: string;
  pendingSend: {
    clientMessageId: string;
    body: string;
    createdAt: string;
  } | null;
  updatedAt?: string;
}
export interface StudioTeamDraftStore {
  retainAuthorizedTeams(input: {
    backendId: string;
    principalUserId: string;
    teamIds: string[];
  }): Promise<number>;
  load(authority: StudioTeamDraftAuthority): Promise<StudioTeamDraft | null>;
  save(input: {
    authority: StudioTeamDraftAuthority;
    draft: StudioTeamDraft;
  }): Promise<void>;
  delete(authority: StudioTeamDraftAuthority): Promise<void>;
  deleteTeam(
    authority: Omit<StudioTeamDraftAuthority, "threadId">
  ): Promise<void>;
}

export interface StudioGatewayOptions {
  host: "127.0.0.1";
  port: 0;
  apiBase: string;
  staticDir: string;
  resolveToken: () => Promise<string>;
  resolveAccess?: () => Promise<StudioLocalAccess>;
  listLocalSources: (input: Record<string, unknown>) => Promise<unknown>;
  listProjects: () => Promise<unknown>;
  chooseProjectDirectory: () => Promise<string | null>;
  registerProject: (input: { path: string; name: string }) => Promise<unknown>;
  loadCollaborationSnapshot?: () => Promise<StudioCollaborationSnapshot>;
  connectCollaborationBackend?: (
    remoteUrl: string
  ) => Promise<StudioCollaborationSnapshot>;
  reconnectCollaborationBackend?: () => Promise<StudioCollaborationSnapshot>;
  disconnectCollaborationBackend?: () => Promise<StudioCollaborationSnapshot>;
  loadStudioCollaborationSnapshot?: () => Promise<CollaborationSnapshot>;
  loadStudioTeamDraft?: StudioTeamDraftStore["load"];
  saveStudioTeamDraft?: StudioTeamDraftStore["save"];
  deleteStudioTeamDraft?: StudioTeamDraftStore["delete"];
  deleteStudioTeamDraftsForTeam?: StudioTeamDraftStore["deleteTeam"];
  runStudioCollaborationCommand?: (
    command: CollaborationRendererCommand
  ) => Promise<CollaborationCommandResult>;
  confirmNativeReview?: (
    review: CollaborationApprovalReview
  ) => Promise<boolean>;
  subscribeStudioCollaborationEvents?: (
    listener: (event: CollaborationRendererEvent) => void
  ) => () => void;
}

export const resolveStudioPaths = (input: {
  appIsPackaged: boolean;
  repoRoot: string;
  resourcesPath: string;
}): { gatewayPath: string; staticDir: string } => {
  const studioRoot = input.appIsPackaged
    ? resolve(input.resourcesPath, "studio")
    : resolve(input.repoRoot, "apps/studio");
  return {
    gatewayPath: resolve(studioRoot, "server/index.mjs"),
    staticDir: resolve(studioRoot, "out")
  };
};

export const studioWindowOptions: BrowserWindowConstructorOptions = {
  title: "Koed Studio",
  width: 1440,
  height: 960,
  minWidth: 1000,
  minHeight: 700,
  show: false,
  titleBarStyle: "hiddenInset",
  backgroundColor: "#000000",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
};

export const createStudioWindowController = (input: {
  allowedRendererOrigins: Set<string>;
  studioRendererOrigins?: Set<string>;
  createWindow: () => StudioWindowLike;
  getAccess: () => Promise<StudioLocalAccess>;
  defaultApiOrigin: string;
  getPaths: () => { gatewayPath: string; staticDir: string };
  startGateway: (options: StudioGatewayOptions) => Promise<StudioGateway>;
  listLocalSources: (input: Record<string, unknown>) => Promise<unknown>;
  listProjects: () => Promise<unknown>;
  chooseProjectDirectory: () => Promise<string | null>;
  registerProject: (input: { path: string; name: string }) => Promise<unknown>;
  collaboration: (
    args: Record<string, unknown>,
    context: DesktopCommandContext
  ) => unknown;
  confirmNativeReview?: (
    review: CollaborationApprovalReview
  ) => Promise<boolean>;
  getTeamDraftStore?: () => Promise<StudioTeamDraftStore>;
  openExternal: (url: string) => Promise<unknown>;
}): { open: () => Promise<void>; close: () => Promise<void> } => {
  let window: StudioWindowLike | null = null;
  let gateway: StudioGateway | null = null;
  let opening: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let studioOrigin: string | null = null;
  let collaborationLifecycle: AbortController | null = null;
  let collaborationOwnerId: string | null = null;

  let verifiedSnapshot: CollaborationSnapshot | null = null;
  const rememberSnapshot = async (
    snapshot: CollaborationSnapshot
  ): Promise<void> => {
    if (snapshot.connection.state !== "live") return;
    const previous = verifiedSnapshot;
    verifiedSnapshot = snapshot;
    if (
      snapshot.connection.backendId &&
      snapshot.navigation.teamPrincipal &&
      input.getTeamDraftStore
    ) {
      const store = await input.getTeamDraftStore();
      if (verifiedSnapshot !== snapshot) return;
      await store.retainAuthorizedTeams({
        backendId: snapshot.connection.backendId,
        principalUserId: snapshot.navigation.teamPrincipal.id,
        teamIds: snapshot.navigation.teams.map((team) => team.id)
      });
    }
    if (
      previous &&
      previous.connection.backendId === snapshot.connection.backendId &&
      previous.navigation.teamPrincipal?.id ===
        snapshot.navigation.teamPrincipal?.id &&
      input.getTeamDraftStore
    ) {
      const removed = previous.navigation.teams.filter(
        (team) =>
          !snapshot.navigation.teams.some((current) => current.id === team.id)
      );
      if (
        removed.length &&
        previous.connection.backendId &&
        previous.navigation.teamPrincipal
      ) {
        const store = await input.getTeamDraftStore();
        for (const team of removed)
          await store.deleteTeam({
            backendId: previous.connection.backendId,
            principalUserId: previous.navigation.teamPrincipal.id,
            teamId: team.id
          });
      }
    }
  };
  const forgetRevokedDrafts = async (): Promise<void> => {
    const previous = verifiedSnapshot;
    verifiedSnapshot = null;
    if (
      !previous?.connection.backendId ||
      !previous.navigation.teamPrincipal ||
      !input.getTeamDraftStore
    )
      return;
    const store = await input.getTeamDraftStore();
    for (const team of previous.navigation.teams)
      await store.deleteTeam({
        backendId: previous.connection.backendId,
        principalUserId: previous.navigation.teamPrincipal.id,
        teamId: team.id
      });
  };
  const assertDraftAuthority = (authority: StudioTeamDraftAuthority): void => {
    const snapshot = verifiedSnapshot;
    if (
      !snapshot ||
      snapshot.connection.backendId !== authority.backendId ||
      snapshot.navigation.teamPrincipal?.id !== authority.principalUserId
    )
      throw new Error("Team draft authority is unavailable.");
    const team = snapshot.navigation.teams.find(
      (item) => item.id === authority.teamId
    );
    if (!team) throw new Error("Team draft access is unavailable.");
    let found = false;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const parsed = collaborationThreadSchema.safeParse(value);
      if (
        parsed.success &&
        parsed.data.scope === "team" &&
        parsed.data.teamId === authority.teamId &&
        parsed.data.id === authority.threadId
      )
        found = true;
      for (const item of Object.values(value)) visit(item);
    };
    visit(team);
    if (!found) throw new Error("Team draft channel is unavailable.");
  };
  const draftStore = async () => {
    if (!input.getTeamDraftStore)
      throw new Error("Protected Team drafts are unavailable.");
    return input.getTeamDraftStore();
  };
  const subscriptionTeams = new Map<string, string>();
  const collaborationListeners = new Set<
    (event: CollaborationRendererEvent) => void
  >();
  const emitCollaborationEvent = (event: CollaborationRendererEvent): void => {
    if (collaborationLifecycle?.signal.aborted || !collaborationOwnerId) return;
    const parsed = collaborationRendererEventSchema.safeParse(event);
    if (!parsed.success) return;
    event = parsed.data;
    if (
      event.type === "snapshot" &&
      event.subscription.scope.scope === "team"
    ) {
      subscriptionTeams.set(
        event.subscription.id,
        event.subscription.scope.teamId
      );
      if (
        event.snapshot.scope === "team" &&
        verifiedSnapshot &&
        event.snapshot.teamPrincipal.id ===
          verifiedSnapshot.navigation.teamPrincipal?.id
      ) {
        const teamSnapshot = event.snapshot;
        verifiedSnapshot = {
          ...verifiedSnapshot,
          navigation: {
            ...verifiedSnapshot.navigation,
            teams: verifiedSnapshot.navigation.teams.map((team) =>
              team.id === teamSnapshot.teamId ? teamSnapshot.team : team
            )
          }
        };
      }
    }
    if (
      event.type === "update" &&
      event.update.type === "navigation_snapshot" &&
      verifiedSnapshot
    ) {
      void rememberSnapshot({
        ...verifiedSnapshot,
        navigation: event.update.navigation,
        selection: event.update.selection,
        view: event.update.view
      }).catch(() => undefined);
    }
    if (
      event.type === "connection" &&
      event.connection.state === "access_revoked"
    ) {
      void forgetRevokedDrafts().catch(() => undefined);
    }
    if (event.type === "control" && event.reason === "access_revoked") {
      const teamId = subscriptionTeams.get(event.subscriptionId);
      const previous = verifiedSnapshot;
      if (
        teamId &&
        previous?.connection.backendId &&
        previous.navigation.teamPrincipal
      ) {
        verifiedSnapshot = {
          ...previous,
          navigation: {
            ...previous.navigation,
            teams: previous.navigation.teams.filter(
              (team) => team.id !== teamId
            )
          }
        };
        if (input.getTeamDraftStore)
          void input
            .getTeamDraftStore()
            .then((store) =>
              store.deleteTeam({
                backendId: previous.connection.backendId!,
                principalUserId: previous.navigation.teamPrincipal!.id,
                teamId
              })
            )
            .catch(() => undefined);
      }
      subscriptionTeams.delete(event.subscriptionId);
    }
    for (const listener of collaborationListeners) {
      try {
        listener(event);
      } catch {
        /* A closed view must not interrupt broker delivery. */
      }
    }
  };
  const studioChannelCommands = new Set([
    "collaboration.load",
    "collaboration.select",
    "collaboration.preview_shared_memory_candidate",
    "collaboration.prepare_shared_memory_source",
    "collaboration.preview_shared_memory",
    "collaboration.load_shared_memory_preview_page",
    "collaboration.share_memory",
    "collaboration.revoke_shared_memory",
    "collaboration.change_shared_memory_fidelity",
    "collaboration.list_owned_shared_memory_grants",
    "collaboration.list_owned_shares",
    "collaboration.get_owned_share",
    "collaboration.control_pending_share",
    "collaboration.ensure_team_memory_destination",
    "collaboration.get_team_memory_retention",
    "collaboration.list_team_memory_retention_members",
    "collaboration.update_team_memory_retention",
    "collaboration.list_team_retained_memory",
    "collaboration.remove_team_retained_memory",
    "collaboration.stop_owned_team_memory_updates",
    "collaboration.create_team_channel",
    "collaboration.create_team_shared_project",
    "collaboration.start_direct_message",
    "collaboration.start_group_direct_message",
    "collaboration.send_message",
    "collaboration.retry_message",
    "collaboration.get_send_receipt",
    "collaboration.acknowledge_send_receipt",
    "collaboration.load_message_page",
    "collaboration.mark_read",
    "collaboration.mark_delivered",
    "collaboration.subscribe",
    "collaboration.unsubscribe",
    "collaboration.acknowledge_delivery"
  ]);
  const protectedStudioCommands = new Set([
    "collaboration.preview_shared_memory",
    "collaboration.share_memory",
    "collaboration.revoke_shared_memory",
    "collaboration.change_shared_memory_fidelity",
    "collaboration.update_team_memory_retention",
    "collaboration.remove_team_retained_memory",
    "collaboration.stop_owned_team_memory_updates"
  ]);
  const runOwnedStudioCommand = async (
    command: CollaborationRendererCommand,
    lifecycle: AbortController,
    ownerId: string
  ): Promise<CollaborationCommandResult> => {
    const context: DesktopCommandContext = {
      ownerId,
      signal: lifecycle.signal,
      emitCollaborationEvent: (event) => {
        if (
          lifecycle === collaborationLifecycle &&
          ownerId === collaborationOwnerId
        ) emitCollaborationEvent(event);
      }
    };
    const result = collaborationCommandResultSchema.parse(
      await input.collaboration(command, context)
    );
    if (
      lifecycle !== collaborationLifecycle ||
      lifecycle.signal.aborted ||
      ownerId !== collaborationOwnerId ||
      result.requestId !== command.requestId ||
      result.command !== command.command
    ) {
      throw new Error("Studio collaboration authority changed during the request.");
    }
    return result;
  };

  const issueStudioActionGrant = async (
    command: CollaborationRendererCommand,
    lifecycle: AbortController,
    ownerId: string
  ): Promise<CollaborationActionGrantReference> => {
    const inputRecord = command.input as Record<string, unknown>;
    if ("actionGrant" in inputRecord) {
      throw new Error("Studio cannot supply an Action Grant reference.");
    }
    const intent = collaborationActionGrantIntentSchema.parse({
      intent: command.command,
      commandRequestId: command.requestId,
      ...inputRecord
    });
    const authorityFingerprint = (): string => {
      const snapshot = verifiedSnapshot;
      if (
        !snapshot ||
        snapshot.connection.state !== "live" ||
        !snapshot.connection.backendId ||
        !snapshot.navigation.teamPrincipal
      ) {
        throw new Error("Studio collaboration authority is unavailable.");
      }
      const teamId =
        typeof inputRecord.teamId === "string" ? inputRecord.teamId : null;
      const team = teamId
        ? snapshot.navigation.teams.find((entry) => entry.id === teamId)
        : null;
      if (teamId && !team) {
        throw new Error("Team access changed before the operation completed.");
      }
      const source = sharedMemorySourceRefSchema.safeParse(inputRecord.source);
      let sourceIdentity: unknown = null;
      if (source.success) {
        if (source.data.kind === "captured_session") {
          const sessionId = source.data.sessionId;
          const logicalMemoryId = source.data.logicalMemoryId;
          const entry = snapshot.navigation.personal.memory.find(
            (item) =>
              item.id === sessionId && item.logicalMemoryId === logicalMemoryId
          );
          if (!entry) {
            throw new Error("The selected Conversation source is no longer available.");
          }
          sourceIdentity = { sessionId, logicalMemoryId };
        } else if (source.data.kind === "personal_note") {
          sourceIdentity = {
            noteId: source.data.noteId,
            noteRevision: source.data.noteRevision,
            memoryEventId: source.data.memoryEventId,
            logicalMemoryId: source.data.logicalMemoryId
          };
        }
      }
      return JSON.stringify({
        backendId: snapshot.connection.backendId,
        principalId: snapshot.navigation.teamPrincipal.id,
        teamId,
        teamRole: team?.role ?? null,
        selection: snapshot.selection,
        sourceIdentity
      });
    };
    const expectedAuthority = authorityFingerprint();
    const assertAuthorityCurrent = (): void => {
      if (authorityFingerprint() !== expectedAuthority) {
        throw new Error("Team, account, or selected source changed during native review.");
      }
    };
    const actionCommand = async (
      name:
        | "collaboration.request_action_grant"
        | "collaboration.confirm_action_grant"
        | "collaboration.await_action_grant",
      input: Record<string, unknown>
    ) => {
      const grantCommand = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: name,
        input
      });
      return runOwnedStudioCommand(grantCommand, lifecycle, ownerId);
    };
    let grantResult = await actionCommand("collaboration.request_action_grant", { intent });
    if (!grantResult.ok || grantResult.command !== "collaboration.request_action_grant") {
      throw new Error("Native Action Grant request failed.");
    }
    let status = grantResult.data.status;
    while (status.state === "review_required" || status.state === "pending") {
      if (status.state === "review_required") {
        if (!status.review || !input.confirmNativeReview) {
          throw new Error("Native review is unavailable.");
        }
        const approved = await input.confirmNativeReview(status.review);
        if (lifecycle !== collaborationLifecycle || lifecycle.signal.aborted || ownerId !== collaborationOwnerId) {
          throw new Error("Studio collaboration authority changed during review.");
        }
        assertAuthorityCurrent();
        const decisionResult = await actionCommand("collaboration.confirm_action_grant", {
          actionGrant: status.actionGrant,
          decision: approved ? "approve" : "cancel"
        });
        if (!decisionResult.ok || decisionResult.command !== "collaboration.confirm_action_grant") {
          throw new Error("Native Action Grant decision failed.");
        }
        status = decisionResult.data.status;
        if (!approved) throw new Error("Action Grant was declined.");
        continue;
      }
      if (Date.parse(status.expiresAt) <= Date.now()) {
        throw new Error("Native Action Grant expired.");
      }
      const awaited = await actionCommand("collaboration.await_action_grant", {
        actionGrant: status.actionGrant
      });
      if (!awaited.ok || awaited.command !== "collaboration.await_action_grant") {
        throw new Error("Native Action Grant wait failed.");
      }
      status = awaited.data.status;
    }
    assertAuthorityCurrent();
    if (status.state !== "approved") throw new Error("Action Grant was not approved.");
    return status.actionGrant;
  };

  const runStudioCollaborationCommand = async (
    args: CollaborationRendererCommand
  ): Promise<CollaborationCommandResult> => {
    const command = collaborationRendererCommandSchema.parse(args);
    if (!studioChannelCommands.has(command.command))
      throw new Error("Studio channel command is unavailable.");
    if (
      command.command === "collaboration.select" &&
      !("teamId" in command.input.selection)
    ) {
      throw new Error("Studio channel selection requires a Team.");
    }
    if (
      command.command === "collaboration.subscribe" &&
      command.input.scope.scope !== "team"
    ) {
      throw new Error("Studio channel subscription requires a Team.");
    }
    if ("thread" in command.input && command.input.thread.scope !== "team") {
      throw new Error("Studio channel messages require a Team.");
    }
    const lifecycle = collaborationLifecycle;
    const ownerId = collaborationOwnerId;
    if (!lifecycle || lifecycle.signal.aborted || !ownerId)
      throw new Error("Studio collaboration is unavailable.");
    const actionGrant = protectedStudioCommands.has(command.command)
      ? await issueStudioActionGrant(command, lifecycle, ownerId)
      : undefined;
    const authorizedCommand = actionGrant
      ? collaborationRendererCommandSchema.parse({
          ...command,
          input: { ...command.input, actionGrant }
        })
      : command;
    const result = await runOwnedStudioCommand(
      authorizedCommand,
      lifecycle,
      ownerId
    );
    if (
      lifecycle !== collaborationLifecycle ||
      lifecycle.signal.aborted ||
      result.requestId !== command.requestId ||
      result.command !== command.command
    ) {
      throw new Error(
        "Studio collaboration response did not match its request."
      );
    }
    if (
      result.ok &&
      result.command === "collaboration.subscribe" &&
      result.data.subscription.scope.scope === "team"
    )
      subscriptionTeams.set(
        result.data.subscription.id,
        result.data.subscription.scope.teamId
      );
    if (result.ok && result.command === "collaboration.unsubscribe")
      subscriptionTeams.delete(
        command.command === "collaboration.unsubscribe"
          ? command.input.subscriptionId
          : ""
      );
    if (result.ok && "snapshot" in result.data)
      await rememberSnapshot(
        collaborationSnapshotSchema.parse(result.data.snapshot)
      );
    if (!result.ok && result.error.code === "access_revoked")
      await forgetRevokedDrafts();
    return result;
  };
  const loadStudioCollaborationSnapshot =
    async (): Promise<CollaborationSnapshot> => {
      const result = await runStudioCollaborationCommand({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: { forceRemoteNavigation: true }
      });
      if (!result.ok || result.command !== "collaboration.load")
        throw new Error("Studio collaboration is unavailable.");
      const snapshot = collaborationSnapshotSchema.parse(result.data.snapshot);
      if (snapshot.connection.state !== "live")
        throw new Error("Studio collaboration is unavailable.");
      return snapshot;
    };

  const runCollaborationCommand = async (
    commandName:
      | "collaboration.connect_backend"
      | "collaboration.reconnect_backend"
      | "collaboration.disconnect_backend",
    commandInput: Record<string, unknown>
  ): Promise<StudioCollaborationSnapshot> => {
    const lifecycle = collaborationLifecycle;
    const ownerId = collaborationOwnerId;
    if (!lifecycle || lifecycle.signal.aborted || !ownerId) {
      throw new Error("Studio collaboration is unavailable.");
    }
    const command = collaborationRendererCommandSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: randomUUID(),
      command: commandName,
      input: commandInput
    });
    const context: DesktopCommandContext = {
      ownerId,
      signal: lifecycle.signal,
      emitCollaborationEvent: (event) => {
        if (
          lifecycle === collaborationLifecycle &&
          ownerId === collaborationOwnerId
        )
          emitCollaborationEvent(event);
      }
    };
    const result = collaborationCommandResultSchema.parse(
      await input.collaboration(command, context)
    );
    if (
      result.requestId !== command.requestId ||
      result.command !== command.command
    ) {
      throw new Error(
        "Studio collaboration response did not match its request."
      );
    }
    if (!result.ok) {
      const fallback: StudioCollaborationSnapshot = {
        connection: {
          state:
            result.error.code === "access_revoked"
              ? "access_revoked"
              : "unavailable",
          backendId: null,
          connectedAt: null,
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        },
        teams: []
      };
      const current = await loadCollaborationSnapshot().catch(() => fallback);
      return {
        ...current,
        error: result.error.userMessage
      };
    }
    if (
      result.command !== "collaboration.connect_backend" &&
      result.command !== "collaboration.reconnect_backend" &&
      result.command !== "collaboration.disconnect_backend"
    ) {
      throw new Error("Studio collaboration response was invalid.");
    }
    const snapshot = collaborationSnapshotSchema.parse(result.data.snapshot);
    if (commandName === "collaboration.disconnect_backend")
      verifiedSnapshot = null;
    else await rememberSnapshot(snapshot);
    return {
      connection: snapshot.connection,
      teams:
        snapshot.connection.state === "live"
          ? snapshot.navigation.teams.map((team) => ({
              id: team.id,
              name: team.name,
              role: team.role,
              unreadCount: team.unreadCount,
              people: team.people.map(({ id, displayName }) => ({
                id,
                displayName
              })),
              workspaces: team.workspaces.map(({ id, name }) => ({
                id,
                name
              }))
            }))
          : []
    };
  };

  const loadCollaborationSnapshot =
    async (): Promise<StudioCollaborationSnapshot> => {
      const unavailable = (): StudioCollaborationSnapshot => ({
        connection: {
          state: "unavailable",
          backendId: null,
          connectedAt: null,
          retryAt: null,
          reconnectAttempt: 0,
          protocolVersion: COLLABORATION_CONTRACT_VERSION
        },
        teams: []
      });
      const lifecycle = collaborationLifecycle;
      const ownerId = collaborationOwnerId;
      if (!lifecycle || lifecycle.signal.aborted || !ownerId) {
        return unavailable();
      }
      const command = collaborationRendererCommandSchema.parse({
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: randomUUID(),
        command: "collaboration.load",
        input: { forceRemoteNavigation: true }
      });
      const context: DesktopCommandContext = {
        ownerId,
        signal: lifecycle.signal,
        emitCollaborationEvent: (event) => {
          if (
            lifecycle === collaborationLifecycle &&
            ownerId === collaborationOwnerId
          )
            emitCollaborationEvent(event);
        }
      };
      let result: ReturnType<typeof collaborationCommandResultSchema.parse>;
      try {
        result = collaborationCommandResultSchema.parse(
          await input.collaboration(command, context)
        );
      } catch {
        return unavailable();
      }
      if (
        result.requestId !== command.requestId ||
        result.command !== command.command
      ) {
        throw new Error(
          "Studio collaboration response did not match its request."
        );
      }
      if (!result.ok) {
        if (result.error.code === "access_revoked") {
          await forgetRevokedDrafts();
          return {
            connection: {
              state: "access_revoked",
              backendId: null,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: COLLABORATION_CONTRACT_VERSION
            },
            teams: []
          };
        }
        return unavailable();
      }
      if (result.command !== "collaboration.load") {
        throw new Error("Studio collaboration response was invalid.");
      }
      const snapshot = collaborationSnapshotSchema.parse(result.data.snapshot);
      await rememberSnapshot(snapshot);
      return {
        connection: snapshot.connection,
        teams:
          snapshot.connection.state === "live"
            ? snapshot.navigation.teams.map((team) => ({
                id: team.id,
                name: team.name,
                role: team.role,
                unreadCount: team.unreadCount,
                people: team.people.map(({ id, displayName }) => ({
                  id,
                  displayName
                })),
                workspaces: team.workspaces.map(({ id, name }) => ({
                  id,
                  name
                }))
              }))
            : []
      };
    };

  const disposeGateway = async () => {
    collaborationLifecycle?.abort();
    collaborationLifecycle = null;
    collaborationOwnerId = null;
    collaborationListeners.clear();
    subscriptionTeams.clear();
    verifiedSnapshot = null;
    const currentGateway = gateway;
    gateway = null;
    if (studioOrigin) input.allowedRendererOrigins.delete(studioOrigin);
    if (studioOrigin) input.studioRendererOrigins?.delete(studioOrigin);
    studioOrigin = null;
    await currentGateway?.close();
  };

  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      await opening?.catch(() => undefined);
      const currentWindow = window;
      window = null;
      if (currentWindow && !currentWindow.isDestroyed()) currentWindow.close();
      await disposeGateway();
    })().finally(() => {
      closing = null;
    });
    return closing;
  };

  const open = async () => {
    if (closing) await closing;
    if (opening) return opening;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    if (window || gateway) await close();
    opening = (async () => {
      collaborationLifecycle = new AbortController();
      collaborationOwnerId = `studio-window:${randomUUID()}`;
      let access: StudioLocalAccess | null = null;
      try {
        access = await input.getAccess();
      } catch {
        // Studio remains useful while Koed services start or recover.
      }
      const paths = input.getPaths();
      const started = await input.startGateway({
        host: "127.0.0.1",
        port: 0,
        apiBase: access?.apiOrigin ?? input.defaultApiOrigin,
        staticDir: paths.staticDir,
        resolveToken: async () => (await input.getAccess()).apiToken,
        resolveAccess: input.getAccess,
        listLocalSources: input.listLocalSources,
        listProjects: input.listProjects,
        chooseProjectDirectory: async () => {
          if (!window || window.isDestroyed()) return null;
          return input.chooseProjectDirectory();
        },
        registerProject: input.registerProject,
        loadCollaborationSnapshot,
        runStudioCollaborationCommand,
        ...(input.confirmNativeReview
          ? { confirmNativeReview: input.confirmNativeReview }
          : {}),
        loadStudioCollaborationSnapshot,
        loadStudioTeamDraft: async (authority) => {
          await loadStudioCollaborationSnapshot();
          assertDraftAuthority(authority);
          const store = await draftStore();
          assertDraftAuthority(authority);
          const draft = await store.load(authority);
          assertDraftAuthority(authority);
          return draft;
        },
        saveStudioTeamDraft: async (request) => {
          assertDraftAuthority(request.authority);
          const store = await draftStore();
          assertDraftAuthority(request.authority);
          await store.save(request);
        },
        deleteStudioTeamDraft: async (authority) => {
          assertDraftAuthority(authority);
          await (await draftStore()).delete(authority);
        },
        deleteStudioTeamDraftsForTeam: async (authority) => {
          if (
            verifiedSnapshot?.connection.backendId !== authority.backendId ||
            verifiedSnapshot.navigation.teamPrincipal?.id !==
              authority.principalUserId
          )
            throw new Error("Team draft authority is unavailable.");
          await (await draftStore()).deleteTeam(authority);
        },
        subscribeStudioCollaborationEvents: (listener) => {
          collaborationListeners.add(listener);
          return () => {
            collaborationListeners.delete(listener);
          };
        },
        connectCollaborationBackend: (remoteUrl) =>
          runCollaborationCommand("collaboration.connect_backend", {
            remoteUrl
          }),
        reconnectCollaborationBackend: () =>
          runCollaborationCommand("collaboration.reconnect_backend", {}),
        disconnectCollaborationBackend: () =>
          runCollaborationCommand("collaboration.disconnect_backend", {})
      });
      gateway = started;
      try {
        const origin = desktopRendererOrigin(started.url);
        studioOrigin = origin;
        input.allowedRendererOrigins.add(origin);
        input.studioRendererOrigins?.add(origin);
        const createdWindow = input.createWindow();
        window = createdWindow;
        createdWindow.webContents.setWindowOpenHandler(({ url }) => {
          if (url.startsWith("https://") || url.startsWith("http://")) {
            void input.openExternal(url);
          }
          return { action: "deny" };
        });
        createdWindow.webContents.on("will-navigate", (event, url) => {
          try {
            if (desktopRendererOrigin(url) !== origin) event.preventDefault();
          } catch {
            event.preventDefault();
          }
        });
        createdWindow.once("closed", () => {
          if (window === createdWindow) window = null;
          void disposeGateway();
        });
        await createdWindow.loadURL(started.url);
        if (!createdWindow.isDestroyed()) createdWindow.show();
      } catch (error) {
        const failedWindow = window;
        window = null;
        if (failedWindow && !failedWindow.isDestroyed()) failedWindow.close();
        await disposeGateway();
        throw error;
      }
    })()
      .catch((error) => {
        collaborationLifecycle?.abort();
        collaborationLifecycle = null;
        collaborationOwnerId = null;
        collaborationListeners.clear();
        subscriptionTeams.clear();
        verifiedSnapshot = null;
        throw error;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  };

  return { open, close };
};
