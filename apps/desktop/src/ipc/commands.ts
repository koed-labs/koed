import {
  managedMemoryActionChannel,
  managedMemoryActionRequestSchema,
  managedMemoryActionResultSchema,
  type ManagedMemoryActionRequest,
  type ManagedMemoryActionResult
} from "./managed-memory-action-protocol.js";
import {
  managedTextActionChannel,
  managedTextActionRequestSchema,
  managedTextActionResultSchema,
  type ManagedTextActionRequest,
  type ManagedTextActionResult
} from "./managed-text-action-protocol.js";
import { LocalApiRateLimitError } from "../local-api-errors.js";
import {
  deckCommandChannel,
  deckRequestSchema,
  deckResultSchema,
  type DeckRequest,
  type DeckResult
} from "./deck-protocol.js";
import {
  curatedMemoryCommandChannel,
  curatedMemoryRequestSchema,
  curatedMemoryResultSchema,
  type CuratedMemoryRequest,
  type CuratedMemoryResult
} from "./curated-memory-protocol.js";
import {
  projectsCommandChannel,
  projectsRequestSchema,
  projectsResultSchema,
  type ProjectsRequest,
  type ProjectsResult
} from "./projects-protocol.js";
import {
  agentsCommandChannel,
  agentsRequestSchema,
  agentsResultSchema,
  type AgentsRequest,
  type AgentsResult
} from "./agents-protocol.js";
import {
  scheduledJobsChannel,
  scheduledJobsRequestSchema,
  scheduledJobsResultSchema,
  type ScheduledJobsRequest,
  type ScheduledJobsResult
} from "./scheduled-jobs-protocol.js";
import {
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationDesktopRendererEventSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema
} from "@koed/shared";
import type { PersonalDesktopResult } from "@koed/shared/personal-desktop";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type {
  DesktopCommandContext,
  DesktopCommandHandler,
  LocalAiClientDesktopHandler,
  PersonalMemoryDesktopHandler
} from "../koed-server/manager.js";
import type {
  DesktopLaunchAtStartupState,
  DesktopSetupSnapshot
} from "../types.js";
import {
  collaborationCommandChannel,
  collaborationEventChannel,
  clipboardWriteChannel,
  localAiClientCommandChannel,
  desktopRendererOrigin,
  isDesktopCommandName,
  managedConversationCommandChannel,
  projectHqConversationChannel,
  managedProjectCommandChannel,
  managedProjectEventChannel,
  personalDevicePairingProgressChannel,
  personalDevicePairingLinkConsumeChannel,
  personalMemoryCommandChannel,
  setupCommandChannel,
  setupProgressEventChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel,
  hardwareAccelerationGetChannel,
  hardwareAccelerationSetChannel,
  launchAtStartupGetChannel,
  launchAtStartupSetChannel,
  type DesktopCommandName
} from "./protocol.js";
import {
  parseManagedConversationRequest,
  parseManagedConversationResult,
  type ManagedConversationRequest,
  type ManagedConversationResult
} from "./managed-conversation-protocol.js";
import {
  projectHqConversationRequestSchema,
  projectHqConversationResultSchema,
  type ProjectHqConversationRequest,
  type ProjectHqConversationResult
} from "./project-hq-conversation-protocol.js";
import { parsePersonalDevicePairingProgress } from "./personal-device-pairing-protocol.js";
import type { DesktopThemePreference } from "../window/theme-preference.js";
import type { HqLayoutPreferences } from "./hq-layout-preferences-protocol.js";
import {
  hqLayoutPreferencesGetArgsSchema,
  hqLayoutPreferencesGetChannel,
  hqLayoutPreferencesResultSchema,
  hqLayoutPreferencesSetArgsSchema,
  hqLayoutPreferencesSetChannel
} from "./hq-layout-preferences-protocol.js";
import type { HqSidebarPreferences } from "./hq-sidebar-preferences-protocol.js";
import {
  hqSidebarPreferencesGetArgsSchema,
  hqSidebarPreferencesGetChannel,
  hqSidebarPreferencesResultSchema,
  hqSidebarPreferencesSetArgsSchema,
  hqSidebarPreferencesSetChannel
} from "./hq-sidebar-preferences-protocol.js";
import type { ManagedPreviewController } from "../window/managed-preview-controller.js";
import { parsePersonalDevicePairingLink } from "../personal-device-pairing-link.js";
import {
  localAiClientCommandSchema,
  localAiClientResponseSchema
} from "./local-ai-client-protocol.js";
import {
  managedProjectEventSchema,
  managedProjectRequestSchema,
  managedProjectResultSchema,
  type ManagedProjectRequest,
  type ManagedProjectResult
} from "./managed-project-protocol.js";

export const invokeChannel = "koed:invoke";

const trustedSender = (
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  allowedRendererOrigins: ReadonlySet<string>
): boolean => {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  try {
    return allowedRendererOrigins.has(
      desktopRendererOrigin(event.senderFrame.url)
    );
  } catch {
    return false;
  }
};

const senderContexts = new WeakMap<
  WebContents,
  { controller: AbortController; context: DesktopCommandContext }
>();

const profileMutationCommands = new Set([
  "setup_codex",
  "repair_codex",
  "remove_codex",
  "setup_pi",
  "repair_pi",
  "remove_pi",
  "setup_claude",
  "repair_claude",
  "remove_claude"
]);

const contextForSender = (sender: WebContents): DesktopCommandContext => {
  const current = senderContexts.get(sender);
  if (current) return current.context;
  const controller = new AbortController();
  const context: DesktopCommandContext = {
    ownerId: String(sender.id),
    signal: controller.signal,
    emitCollaborationEvent: (value) => {
      const event = collaborationDesktopRendererEventSchema.parse(value);
      if (!sender.isDestroyed()) sender.send(collaborationEventChannel, event);
    },
    emitPersonalDevicePairingProgress: (value) => {
      const progress = parsePersonalDevicePairingProgress(value);
      if (!sender.isDestroyed()) {
        sender.send(personalDevicePairingProgressChannel, progress);
      }
    },
    emitSetupProgress: (snapshot: DesktopSetupSnapshot) => {
      if (!sender.isDestroyed()) {
        sender.send(setupProgressEventChannel, snapshot);
      }
    },
    emitManagedProjectEvent: (value) => {
      const event = managedProjectEventSchema.parse(value);
      if (!sender.isDestroyed()) {
        sender.send(managedProjectEventChannel, event);
      }
    }
  };
  senderContexts.set(sender, { controller, context });
  sender.once("destroyed", () => {
    controller.abort();
    senderContexts.delete(sender);
  });
  return context;
};

export const registerDesktopCommandHandlers = (
  ipcMain: Pick<IpcMain, "handle">,
  handlers: Record<DesktopCommandName, DesktopCommandHandler>,
  options: {
    allowedRendererOrigins: ReadonlySet<string>;
    localAiClients?: LocalAiClientDesktopHandler;
    personalMemory: PersonalMemoryDesktopHandler;
    reviewChatDeletion?: (
      sessionId: string,
      batchId: string,
      actionGrantId: string,
      context: DesktopCommandContext
    ) => Promise<
      Extract<
        PersonalDesktopResult,
        { operation: "personal.sessions.delete_review"; ok: true }
      >["data"]
    >;
    reviewChatMove?: (
      sessionId: string,
      batchId: string,
      actionGrantId: string,
      context: DesktopCommandContext
    ) => Promise<
      Extract<
        PersonalDesktopResult,
        { operation: "personal.sessions.move_review"; ok: true }
      >["data"]
    >;
    projects?: (request: ProjectsRequest) => Promise<ProjectsResult>;
    decks?: (request: DeckRequest) => Promise<DeckResult>;
    managedMemoryActions?: (
      request: ManagedMemoryActionRequest
    ) => Promise<ManagedMemoryActionResult>;
    managedTextActions?: (
      request: ManagedTextActionRequest
    ) => Promise<ManagedTextActionResult>;
    curatedMemory?: (
      request: CuratedMemoryRequest
    ) => Promise<CuratedMemoryResult>;
    uploadProjectSource?: (
      projectId: string
    ) => Promise<
      Extract<ProjectsResult, { operation: "sourceUpload" }>["value"]
    >;
    uploadSharedProjectSource?: (
      personalProjectId: string,
      workspaceProjectId: string,
      teamBackendId: string
    ) => Promise<
      Extract<ProjectsResult, { operation: "sharedSourcePick" }>["value"]
    >;
    readProjectSource?: (
      projectId: string,
      sourceId: string,
      noteRevisionId: string
    ) => Promise<Extract<ProjectsResult, { operation: "sourceRead" }>["value"]>;
    removeProjectSource?: (
      projectId: string,
      sourceId: string
    ) => Promise<
      Extract<ProjectsResult, { operation: "sourceRemoval" }>["value"]
    >;
    reviewProjectSource?: (
      projectId: string,
      sourceId: string,
      batchId: string,
      actionGrantId: string,
      context: DesktopCommandContext
    ) => Promise<
      Extract<ProjectsResult, { operation: "sourceReview" }>["value"]
    >;
    pickProjectFolder?: () => Promise<string | null>;
    agents?: (request: AgentsRequest) => Promise<AgentsResult>;
    scheduledJobs?: (
      request: ScheduledJobsRequest
    ) => Promise<ScheduledJobsResult>;
    managedConversation: (
      request: ManagedConversationRequest
    ) => Promise<ManagedConversationResult>;
    projectHqConversation?: (
      request: ProjectHqConversationRequest
    ) => Promise<ProjectHqConversationResult>;
    managedProject: (
      request: ManagedProjectRequest,
      context?: DesktopCommandContext
    ) => Promise<ManagedProjectResult>;
    managedPreview: ManagedPreviewController;
    consumePendingPersonalDevicePairingLink: (
      expectedLink?: string
    ) => string | null;
    writeClipboard: (value: string) => void;
    getThemePreference: () => DesktopThemePreference;
    setThemePreference: (preference: DesktopThemePreference) => {
      preference: DesktopThemePreference;
      resolvedDark: boolean;
    };
    getHqLayoutPreferences: () => HqLayoutPreferences;
    setHqLayoutPreferences: (
      preferences: HqLayoutPreferences
    ) => HqLayoutPreferences;
    getHqSidebarPreferences: () => HqSidebarPreferences;
    setHqSidebarPreferences: (
      preferences: HqSidebarPreferences
    ) => HqSidebarPreferences;
    getHardwareAcceleration?: () => Promise<{
      enabled: boolean;
      managedByEnvironment: boolean;
    }>;
    setHardwareAcceleration?: (enabled: boolean) => Promise<{
      enabled: boolean;
      managedByEnvironment: boolean;
    }>;
    getLaunchAtStartup: () => Promise<DesktopLaunchAtStartupState>;
    setLaunchAtStartup: (
      enabled: boolean
    ) => Promise<DesktopLaunchAtStartupState>;
    selectProjectDirectory?: () => Promise<unknown>;
  }
): void => {
  ipcMain.handle(
    invokeChannel,
    async (event, command: unknown, args?: Record<string, unknown>) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      if (!isDesktopCommandName(command)) {
        throw new Error("Unsupported Desktop command.");
      }
      if (command === "collaboration") {
        throw new Error("Use the strict collaboration command channel.");
      }
      if (command === "select_project_directory") {
        if (args && Object.keys(args).length > 0) {
          throw new Error("Project directory selection takes no arguments.");
        }
        if (!options.selectProjectDirectory) {
          throw new Error("Project directory selection is unavailable.");
        }
        return await options.selectProjectDirectory();
      }
      if (
        profileMutationCommands.has(command) &&
        args?.operatorConsented !== true
      ) {
        throw new Error(
          "Operator consent is required before changing an AI Client profile."
        );
      }
      const handler = handlers[command];
      return await handler(args, contextForSender(event.sender));
    }
  );

  ipcMain.handle(setupCommandChannel, async (event, operation: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    if (operation !== "inspect" && operation !== "run") {
      throw new Error("Unsupported Desktop setup operation.");
    }
    const handler =
      operation === "inspect" ? handlers.setup_inspect : handlers.setup_run;
    return await handler(
      operation === "run" ? { operatorConsented: true } : undefined,
      contextForSender(event.sender)
    );
  });

  ipcMain.handle(collaborationCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    const command = collaborationRendererCommandSchema.parse(value);
    const result = await handlers.collaboration(
      command as unknown as Record<string, unknown>,
      contextForSender(event.sender)
    );
    const parsed = collaborationCommandResultSchema.parse(result);
    if (
      parsed.requestId !== command.requestId ||
      parsed.command !== command.command
    ) {
      throw new Error("Invalid collaboration command correlation.");
    }
    return parsed;
  });

  ipcMain.handle(clipboardWriteChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > 32_768
    ) {
      throw new Error("Invalid Desktop clipboard value.");
    }
    options.writeClipboard(value);
  });

  ipcMain.handle(themePreferenceGetChannel, async (event) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    return options.getThemePreference();
  });

  ipcMain.handle(themePreferenceSetChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    if (value !== "light" && value !== "dark" && value !== "system") {
      throw new Error("Invalid Desktop theme preference.");
    }
    return options.setThemePreference(value);
  });

  ipcMain.handle(
    hqLayoutPreferencesGetChannel,
    async (event, ...args: unknown[]) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      hqLayoutPreferencesGetArgsSchema.parse(args);
      return hqLayoutPreferencesResultSchema.parse(
        options.getHqLayoutPreferences()
      );
    }
  );

  ipcMain.handle(
    hqLayoutPreferencesSetChannel,
    async (event, ...args: unknown[]) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      const [preferences] = hqLayoutPreferencesSetArgsSchema.parse(args);
      return hqLayoutPreferencesResultSchema.parse(
        options.setHqLayoutPreferences(preferences)
      );
    }
  );

  ipcMain.handle(
    hqSidebarPreferencesGetChannel,
    async (event, ...args: unknown[]) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      hqSidebarPreferencesGetArgsSchema.parse(args);
      return hqSidebarPreferencesResultSchema.parse(
        options.getHqSidebarPreferences()
      );
    }
  );

  ipcMain.handle(
    hqSidebarPreferencesSetChannel,
    async (event, ...args: unknown[]) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      const [preferences] = hqSidebarPreferencesSetArgsSchema.parse(args);
      return hqSidebarPreferencesResultSchema.parse(
        options.setHqSidebarPreferences(preferences)
      );
    }
  );

  ipcMain.handle(hardwareAccelerationGetChannel, async (event) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    if (!options.getHardwareAcceleration) {
      throw new Error("Hardware acceleration settings are unavailable.");
    }
    return options.getHardwareAcceleration();
  });

  ipcMain.handle(
    hardwareAccelerationSetChannel,
    async (event, value: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      if (typeof value !== "boolean") {
        throw new Error("Invalid hardware acceleration preference.");
      }
      if (!options.setHardwareAcceleration) {
        throw new Error("Hardware acceleration settings are unavailable.");
      }
      return options.setHardwareAcceleration(value);
    }
  );

  ipcMain.handle(launchAtStartupGetChannel, async (event) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    return options.getLaunchAtStartup();
  });

  ipcMain.handle(launchAtStartupSetChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    if (typeof value !== "boolean") {
      throw new Error("Invalid launch-at-startup preference.");
    }
    return options.setLaunchAtStartup(value);
  });

  ipcMain.handle(
    personalDevicePairingLinkConsumeChannel,
    async (event, expectedLink: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      if (expectedLink !== undefined && typeof expectedLink !== "string") {
        throw new Error("Invalid pending pairing link acknowledgement.");
      }
      if (expectedLink !== undefined) {
        parsePersonalDevicePairingLink(expectedLink);
      }
      return options.consumePendingPersonalDevicePairingLink(expectedLink);
    }
  );

  ipcMain.handle(localAiClientCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    const request = localAiClientCommandSchema.parse(value);
    if (!options.localAiClients) {
      throw new Error("Local AI Client settings are unavailable.");
    }
    const response = localAiClientResponseSchema.parse(
      await options.localAiClients(request)
    );
    if (response.operation !== request.operation) {
      throw new Error("Invalid Local AI Client operation correlation.");
    }
    return response;
  });

  ipcMain.handle(
    personalMemoryCommandChannel,
    async (event, value: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      const request = personalDesktopRequestSchema.parse(value);
      if (request.operation === "personal.sessions.delete_review") {
        if (!options.reviewChatDeletion)
          throw new Error(
            "Conversation deletion Native review is unavailable."
          );
        const data = await options.reviewChatDeletion(
          request.input.sessionId,
          request.input.batchId,
          request.input.actionGrantId,
          contextForSender(event.sender)
        );
        return personalDesktopResultSchema.parse({
          contractVersion: request.contractVersion,
          operation: request.operation,
          ok: true,
          data
        });
      }
      if (request.operation === "personal.sessions.move_review") {
        if (!options.reviewChatMove)
          throw new Error("Conversation move Native review is unavailable.");
        const data = await options.reviewChatMove(
          request.input.sessionId,
          request.input.batchId,
          request.input.actionGrantId,
          contextForSender(event.sender)
        );
        return personalDesktopResultSchema.parse({
          contractVersion: request.contractVersion,
          operation: request.operation,
          ok: true,
          data
        });
      }
      const result = personalDesktopResultSchema.parse(
        await options.personalMemory(request)
      );
      if (result.operation !== request.operation) {
        throw new Error("Invalid Personal Memory operation correlation.");
      }
      return result;
    }
  );

  ipcMain.handle(managedMemoryActionChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (!options.managedMemoryActions)
      throw new Error("Memory actions are unavailable.");
    const request = managedMemoryActionRequestSchema.parse(value);
    const result = managedMemoryActionResultSchema.parse(
      await options.managedMemoryActions(request)
    );
    if (
      result.operation !== request.operation ||
      result.executionId !== request.executionId
    )
      throw new Error("Invalid memory action correlation.");
    return result;
  });

  ipcMain.handle(managedTextActionChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (
      process.env.KOED_DESKTOP_HQ_ENABLED !== "true" ||
      !options.managedTextActions
    )
      throw new Error("Koed text actions are unavailable.");
    const request = managedTextActionRequestSchema.parse(value);
    const result = managedTextActionResultSchema.parse(
      await options.managedTextActions(request)
    );
    if (
      result.operation !== request.operation ||
      result.executionId !== request.executionId
    )
      throw new Error("Invalid Koed text action correlation.");
    return result;
  });

  ipcMain.handle(curatedMemoryCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (!options.curatedMemory)
      throw new Error("Curated Memory is unavailable.");
    const request = curatedMemoryRequestSchema.parse(value);
    const result = curatedMemoryResultSchema.parse(
      await options.curatedMemory(request)
    );
    if (result.operation !== request.operation)
      throw new Error("Invalid memory operation correlation.");
    return result;
  });

  ipcMain.handle(deckCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (!options.decks) throw new Error("Deck study is unavailable.");
    const request = deckRequestSchema.parse(value);
    const result = deckResultSchema.parse(await options.decks(request));
    if (
      result.operation !== request.operation ||
      result.projectId !== request.projectId ||
      ("deckId" in request &&
        (!("deckId" in result) || request.deckId !== result.deckId)) ||
      ("cardId" in request &&
        (!("cardId" in result) || request.cardId !== result.cardId))
    )
      throw new Error("Invalid Deck response correlation.");
    return result;
  });

  ipcMain.handle(projectsCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    const request = projectsRequestSchema.parse(value);
    if (request.operation === "pickFolder") {
      if (!options.pickProjectFolder)
        throw new Error("Project folder selection is unavailable.");
      return projectsResultSchema.parse({
        operation: "pickFolder",
        path: await options.pickProjectFolder()
      });
    }
    if (request.operation === "sourceUpload") {
      if (!options.uploadProjectSource)
        throw new Error("Project Source upload is unavailable.");
      const value = await options.uploadProjectSource(request.projectId);
      if (!value.canceled && value.source.projectId !== request.projectId)
        throw new Error("Invalid Project Source upload identity.");
      return projectsResultSchema.parse({ operation: "sourceUpload", value });
    }
    if (request.operation === "sharedSourcePick") {
      if (!options.uploadSharedProjectSource)
        throw new Error("Shared Project Source upload is unavailable.");
      const value = await options.uploadSharedProjectSource(
        request.personalProjectId,
        request.workspaceProjectId,
        request.teamBackendId
      );
      return projectsResultSchema.parse({
        operation: "sharedSourcePick",
        value
      });
    }
    if (request.operation === "sourceRead") {
      if (!options.readProjectSource)
        throw new Error("Project Source read is unavailable.");
      const value = await options.readProjectSource(
        request.projectId,
        request.sourceId,
        request.noteRevisionId
      );
      if (
        value.sourceId !== request.sourceId ||
        value.noteRevisionId !== request.noteRevisionId
      )
        throw new Error("Invalid Project Source read identity.");
      return projectsResultSchema.parse({ operation: "sourceRead", value });
    }
    if (request.operation === "sourceRemoval") {
      if (!options.removeProjectSource)
        throw new Error("Project Source removal is unavailable.");
      const value = await options.removeProjectSource(
        request.projectId,
        request.sourceId
      );
      return projectsResultSchema.parse({ operation: "sourceRemoval", value });
    }
    if (request.operation === "sourceReview") {
      if (!options.reviewProjectSource)
        throw new Error("Project Source Native review is unavailable.");
      const value = await options.reviewProjectSource(
        request.projectId,
        request.sourceId,
        request.batchId,
        request.actionGrantId,
        contextForSender(event.sender)
      );
      if (value.batchId !== request.batchId)
        throw new Error("Project Source review batch changed.");
      return projectsResultSchema.parse({ operation: "sourceReview", value });
    }
    if (!options.projects) throw new Error("Projects are unavailable.");
    const result = projectsResultSchema.parse(await options.projects(request));
    if (result.operation !== request.operation)
      throw new Error("Invalid Projects operation correlation.");
    if (
      request.operation === "sourceCreate" ||
      request.operation === "sourceRemove" ||
      request.operation === "sourceRetry"
    ) {
      if (
        result.operation !== request.operation ||
        result.value.projectId !== request.projectId ||
        ("sourceId" in request && result.value.id !== request.sourceId)
      )
        throw new Error("Invalid Project Source identity.");
      return result;
    }
    if ("projectId" in request && "value" in result && result.value !== null) {
      const project =
        "project" in result.value ? result.value.project : result.value;
      if ("id" in project && project.id !== request.projectId)
        throw new Error("Invalid Project identity.");
      if (
        "batchId" in request &&
        "operation" in result.value &&
        result.value.operation?.batchId !== request.batchId
      )
        throw new Error("Invalid Project batch identity.");
    }
    return result;
  });
  ipcMain.handle(agentsCommandChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (process.env.KOED_DESKTOP_HQ_ENABLED !== "true" || !options.agents)
      throw new Error("Agents are unavailable.");
    const request = agentsRequestSchema.parse(value);
    const result = agentsResultSchema.parse(await options.agents(request));
    if (result.operation !== request.operation)
      throw new Error("Invalid Agents operation correlation.");
    if (
      request.operation === "patch" &&
      result.operation === "patch" &&
      result.agent.id !== request.id
    )
      throw new Error("Invalid Agent identity.");
    return result;
  });
  ipcMain.handle(scheduledJobsChannel, async (event, value: unknown) => {
    if (!trustedSender(event, options.allowedRendererOrigins))
      throw new Error("Untrusted Desktop IPC sender.");
    if (
      process.env.KOED_DESKTOP_HQ_ENABLED !== "true" ||
      !options.scheduledJobs
    )
      throw new Error("Scheduled Jobs are unavailable.");
    const request = scheduledJobsRequestSchema.parse(value);
    const result = scheduledJobsResultSchema.parse(
      await options.scheduledJobs(request)
    );
    if (result.operation !== request.operation)
      throw new Error("Scheduled Job operation mismatch.");
    if (
      "jobId" in request &&
      "job" in result &&
      result.job.id !== request.jobId
    )
      throw new Error("Scheduled Job identity mismatch.");
    if (
      "jobId" in request &&
      "run" in result &&
      result.run.jobId !== request.jobId
    )
      throw new Error("Scheduled run identity mismatch.");
    if (
      "jobId" in request &&
      result.operation === "runs" &&
      (result.jobId !== request.jobId ||
        result.runs.some((run) => run.jobId !== request.jobId))
    )
      throw new Error("Scheduled run identity mismatch.");
    return result;
  });

  ipcMain.handle(
    projectHqConversationChannel,
    async (event, value: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins))
        throw new Error("Untrusted Desktop IPC sender.");
      if (
        process.env.KOED_DESKTOP_HQ_ENABLED !== "true" ||
        !options.projectHqConversation
      )
        throw new Error("Project HQ Conversation is unavailable.");
      const request = projectHqConversationRequestSchema.parse(value);
      const result = projectHqConversationResultSchema.parse(
        await options.projectHqConversation(request)
      );
      if (result.operation !== request.operation)
        throw new Error("Invalid Project HQ Conversation correlation.");
      return result;
    }
  );

  ipcMain.handle(
    managedConversationCommandChannel,
    async (event, value: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      const request = parseManagedConversationRequest(value);
      let rawResult: ManagedConversationResult;
      try {
        rawResult = await options.managedConversation(request);
      } catch (error) {
        if (error instanceof LocalApiRateLimitError) throw error;
        const messages: Record<ManagedConversationResult["operation"], string> =
          {
            list: "Koed could not list managed Conversations.",
            launch_options:
              "Koed could not load managed Conversation launch options.",
            start: "Koed could not start the managed AI Client Conversation.",
            inspect:
              "Koed could not inspect the managed AI Client Conversation.",
            resume:
              "Koed could not confirm the managed AI Client Conversation.",
            send: "Koed could not submit the prompt to the managed AI Client Conversation.",
            draft_read: "Koed could not restore the local Conversation draft.",
            draft_write: "Koed could not save the local Conversation draft.",
            draft_delete: "Koed could not remove the local Conversation draft.",
            recovery_read:
              "Koed could not restore pending managed Conversations.",
            recovery_write:
              "Koed could not save pending managed Conversations.",
            recovery_delete:
              "Koed could not remove pending managed Conversations.",
            targets: "Koed could not load Personal Devices.",
            usage: "Koed could not load managed Conversation usage.",
            runtime: "Koed could not load managed Conversation activity.",
            turn_citations:
              "Koed could not load Conversation memory citations.",
            citation_detail: "Koed could not open this memory source.",
            runtime_respond:
              "Koed could not answer the managed Conversation request.",
            interrupt: "Koed could not interrupt the active Codex turn.",
            stop: "Koed could not stop the managed Conversation.",
            transfer_status:
              "Koed could not load the managed Conversation transfer status.",
            handoff: "Koed could not move the managed Conversation.",
            fork: "Koed could not fork the managed Conversation.",
            command_discovery:
              "Koed could not discover managed Conversation commands.",
            control_action:
              "Koed could not dispatch the managed Conversation control action."
          };
        // IPC errors deliberately omit causes that can contain private provider diagnostics.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(messages[request.operation]);
      }
      const result = parseManagedConversationResult(rawResult);
      if (result.operation !== request.operation) {
        throw new Error("Invalid Managed Conversation operation correlation.");
      }
      return result;
    }
  );

  ipcMain.handle(managedProjectCommandChannel, async (event, value) => {
    if (!trustedSender(event, options.allowedRendererOrigins)) {
      throw new Error("Untrusted Desktop IPC sender.");
    }
    const request = managedProjectRequestSchema.parse(value);
    const context = contextForSender(event.sender);
    const result = managedProjectResultSchema.parse(
      await options.managedProject(request, {
        ...context,
        managedPreview: {
          attach: (input) =>
            options.managedPreview.attach(
              event.sender,
              input,
              (workspaceEvent) =>
                context.emitManagedProjectEvent?.(workspaceEvent)
            ),
          setBounds: (input) =>
            options.managedPreview.setBounds(
              event.sender,
              input.surfaceId,
              input.bounds
            ),
          reload: (surfaceId) =>
            options.managedPreview.reload(event.sender, surfaceId),
          detach: (surfaceId) =>
            options.managedPreview.detach(event.sender, surfaceId)
        }
      })
    );
    if (
      result.requestId !== request.requestId ||
      result.executionId !== request.executionId ||
      result.operation !== request.operation
    ) {
      throw new Error("Invalid managed Project operation correlation.");
    }
    return result;
  });
};
