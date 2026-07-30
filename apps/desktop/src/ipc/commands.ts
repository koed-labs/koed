import {
  collaborationCommandResultSchema,
  collaborationRendererCommandSchema,
  collaborationRendererEventSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema
} from "@koed/shared";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type {
  DesktopCommandContext,
  DesktopCommandHandler,
  PersonalMemoryDesktopHandler
} from "../koed-server/manager.js";
import type { DesktopSetupSnapshot } from "../types.js";
import {
  collaborationCommandChannel,
  collaborationEventChannel,
  clipboardWriteChannel,
  desktopRendererOrigin,
  isDesktopCommandName,
  managedConversationCommandChannel,
  personalDevicePairingProgressChannel,
  personalDevicePairingLinkConsumeChannel,
  personalMemoryCommandChannel,
  setupCommandChannel,
  setupProgressEventChannel,
  themePreferenceGetChannel,
  themePreferenceSetChannel,
  type DesktopCommandName
} from "./protocol.js";
import {
  parseManagedConversationRequest,
  parseManagedConversationResult,
  type ManagedConversationRequest,
  type ManagedConversationResult
} from "./managed-conversation-protocol.js";
import { parsePersonalDevicePairingProgress } from "./personal-device-pairing-protocol.js";
import type { DesktopThemePreference } from "../window/theme-preference.js";
import { parsePersonalDevicePairingLink } from "../personal-device-pairing-link.js";

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

const contextForSender = (sender: WebContents): DesktopCommandContext => {
  const current = senderContexts.get(sender);
  if (current) return current.context;
  const controller = new AbortController();
  const context: DesktopCommandContext = {
    ownerId: String(sender.id),
    signal: controller.signal,
    emitCollaborationEvent: (value) => {
      const event = collaborationRendererEventSchema.parse(value);
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
    personalMemory: PersonalMemoryDesktopHandler;
    managedConversation: (
      request: ManagedConversationRequest
    ) => Promise<ManagedConversationResult>;
    consumePendingPersonalDevicePairingLink: (
      expectedLink?: string
    ) => string | null;
    writeClipboard: (value: string) => void;
    getThemePreference: () => DesktopThemePreference;
    setThemePreference: (preference: DesktopThemePreference) => {
      preference: DesktopThemePreference;
      resolvedDark: boolean;
    };
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

  ipcMain.handle(
    personalMemoryCommandChannel,
    async (event, value: unknown) => {
      if (!trustedSender(event, options.allowedRendererOrigins)) {
        throw new Error("Untrusted Desktop IPC sender.");
      }
      const request = personalDesktopRequestSchema.parse(value);
      const result = personalDesktopResultSchema.parse(
        await options.personalMemory(request)
      );
      if (result.operation !== request.operation) {
        throw new Error("Invalid Personal Memory operation correlation.");
      }
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
      } catch {
        const messages: Record<ManagedConversationResult["operation"], string> =
          {
            start: "Koed could not start the managed Codex Conversation.",
            inspect: "Koed could not inspect the managed Codex Conversation.",
            resume: "Koed could not confirm the managed Codex Conversation.",
            send: "Koed could not submit the prompt to the managed Codex Conversation.",
            targets: "Koed could not load Personal Devices.",
            transfer_status:
              "Koed could not load the managed Conversation transfer status.",
            handoff: "Koed could not move the managed Conversation.",
            fork: "Koed could not fork the managed Conversation."
          };
        throw new Error(messages[request.operation]);
      }
      const result = parseManagedConversationResult(rawResult);
      if (result.operation !== request.operation) {
        throw new Error("Invalid Managed Conversation operation correlation.");
      }
      return result;
    }
  );
};
