import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  personalDesktopChangeSchema,
  personalDesktopLocalFolderPrepareInputSchema,
  personalDesktopProjectCreateInputSchema,
  personalProjectCommandSchema,
  personalMembershipSyncCommandSchema,
  personalSourceContextCommandSchema,
  personalDesktopAskListInputSchema,
  personalDesktopAskSubmitInputSchema,
  personalDesktopAskThreadInputSchema,
  personalDesktopConversationRecentListInputSchema,
  personalDesktopEventPageInputSchema,
  personalDesktopNoteCreateInputSchema,
  personalDesktopNoteListInputSchema,
  personalDesktopNoteLoadInputSchema,
  personalDesktopNoteRenameInputSchema,
  personalDesktopNoteUpdateInputSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema,
  personalDesktopSessionTitleInputSchema,
  personalDesktopSessionPresentationInputSchema,
  type PersonalDesktopApi,
  type PersonalDesktopRequest,
  type PersonalDesktopResult
} from "@koed/shared/personal-desktop";

import {
  personalMemoryCommandChannel,
  personalMemoryEventChannel
} from "./protocol.js";

type Invoke = (channel: string, value: unknown) => Promise<unknown>;
type On = (
  channel: string,
  listener: (_event: unknown, value: unknown) => void
) => void;
type RemoveListener = On;

const invokePersonalMemory = async (
  invoke: Invoke,
  request: PersonalDesktopRequest
): Promise<PersonalDesktopResult> => {
  const parsedRequest = personalDesktopRequestSchema.parse(request);
  const result = personalDesktopResultSchema.parse(
    await invoke(personalMemoryCommandChannel, parsedRequest)
  );
  if (result.operation !== parsedRequest.operation) {
    throw new Error("Invalid Personal Memory operation correlation.");
  }
  return result;
};

const requireSuccess = <Result extends PersonalDesktopResult>(
  result: Result
): Extract<Result, { ok: true }> => {
  if (!result.ok) throw new Error(result.error.message);
  return result as Extract<Result, { ok: true }>;
};

export const createPersonalMemoryPreloadApi = (
  invoke: Invoke,
  events: { on: On; removeListener: RemoveListener }
): PersonalDesktopApi =>
  Object.freeze({
    projectStatus: async () => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.status",
          input: {}
        })
      );
      if (result.operation !== "personal.projects.status")
        throw new Error("Invalid Project status result.");
      return result.data;
    },
    listLocalFolders: async () => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.folders.local.list",
          input: {}
        })
      );
      if (result.operation !== "personal.folders.local.list")
        throw new Error("Invalid local Folder result.");
      return result.data.folders;
    },
    prepareLocalFolder: async (
      value: Parameters<
        NonNullable<PersonalDesktopApi["prepareLocalFolder"]>
      >[0]
    ) => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.folders.local.prepare",
          input: personalDesktopLocalFolderPrepareInputSchema.parse(value)
        })
      );
      if (result.operation !== "personal.folders.local.prepare")
        throw new Error("Invalid prepared Folder result.");
      return result.data.folder;
    },
    manageMembershipSync: async (
      value: Parameters<
        NonNullable<PersonalDesktopApi["manageMembershipSync"]>
      >[0]
    ) => {
      const input = personalMembershipSyncCommandSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.sync",
          input
        })
      );
      if (result.operation !== "personal.projects.sync")
        throw new Error("Invalid Project sync result.");
      return result.data;
    },
    manageSourceContext: async (
      value: Parameters<
        NonNullable<PersonalDesktopApi["manageSourceContext"]>
      >[0]
    ) => {
      const input = personalSourceContextCommandSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.sources.manage",
          input
        })
      );
      if (result.operation !== "personal.sources.manage")
        throw new Error("Invalid source context result.");
      return result.data;
    },
    manageProject: async (
      value: Parameters<NonNullable<PersonalDesktopApi["manageProject"]>>[0]
    ) => {
      const input = personalProjectCommandSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.manage",
          input
        })
      );
      if (result.operation !== "personal.projects.manage")
        throw new Error("Invalid Personal Project result.");
      return result.data;
    },
    listRecentConversations: async (
      value: Parameters<
        NonNullable<PersonalDesktopApi["listRecentConversations"]>
      >[0]
    ) => {
      const input =
        personalDesktopConversationRecentListInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.conversations.recent.list",
          input
        })
      );
      if (result.operation !== "personal.conversations.recent.list") {
        throw new Error("Invalid recent Conversations result.");
      }
      return result.data;
    },
    listAskThreads: async (
      value: Parameters<NonNullable<PersonalDesktopApi["listAskThreads"]>>[0]
    ) => {
      const input = personalDesktopAskListInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.ask.threads.list",
          input
        })
      );
      if (result.operation !== "personal.ask.threads.list") {
        throw new Error("Invalid Personal Ask threads result.");
      }
      return result.data;
    },
    loadAskThread: async (
      value: Parameters<NonNullable<PersonalDesktopApi["loadAskThread"]>>[0]
    ) => {
      const input = personalDesktopAskThreadInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.ask.thread.load",
          input
        })
      );
      if (result.operation !== "personal.ask.thread.load") {
        throw new Error("Invalid Personal Ask thread result.");
      }
      return result.data.turns;
    },
    submitAsk: async (
      value: Parameters<NonNullable<PersonalDesktopApi["submitAsk"]>>[0]
    ) => {
      const input = personalDesktopAskSubmitInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.ask.submit",
          input
        })
      );
      if (result.operation !== "personal.ask.submit") {
        throw new Error("Invalid Personal Ask submit result.");
      }
      return result.data.question;
    },
    listNotes: async (
      value: Parameters<NonNullable<PersonalDesktopApi["listNotes"]>>[0]
    ) => {
      const input = personalDesktopNoteListInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.notes.list",
          input
        })
      );
      if (result.operation !== "personal.notes.list") {
        throw new Error("Invalid Personal Notes list result.");
      }
      return result.data;
    },
    loadNote: async (
      value: Parameters<NonNullable<PersonalDesktopApi["loadNote"]>>[0]
    ) => {
      const input = personalDesktopNoteLoadInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.notes.load",
          input
        })
      );
      if (result.operation !== "personal.notes.load") {
        throw new Error("Invalid Personal Note result.");
      }
      return result.data.note;
    },
    createNote: async (
      value: Parameters<NonNullable<PersonalDesktopApi["createNote"]>>[0]
    ) => {
      const input = personalDesktopNoteCreateInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.notes.create",
          input
        })
      );
      if (result.operation !== "personal.notes.create") {
        throw new Error("Invalid Personal Note create result.");
      }
      return result.data.note;
    },
    renameNote: async (
      value: Parameters<NonNullable<PersonalDesktopApi["renameNote"]>>[0]
    ) => {
      const input = personalDesktopNoteRenameInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.notes.rename",
          input
        })
      );
      if (result.operation !== "personal.notes.rename") {
        throw new Error("Invalid Personal Note rename result.");
      }
      return result.data.note;
    },
    updateNote: async (
      value: Parameters<NonNullable<PersonalDesktopApi["updateNote"]>>[0]
    ) => {
      const input = personalDesktopNoteUpdateInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.notes.update",
          input
        })
      );
      if (result.operation !== "personal.notes.update") {
        throw new Error("Invalid Personal Note update result.");
      }
      return result.data.note;
    },
    createProject: async (
      value: Parameters<NonNullable<PersonalDesktopApi["createProject"]>>[0]
    ) => {
      const input = personalDesktopProjectCreateInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.create",
          input
        })
      );
      if (result.operation !== "personal.projects.create")
        throw new Error("Invalid Project creation result.");
      return result.data;
    },
    listNamedProjects: async () => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.named.list",
          input: {}
        })
      );
      if (result.operation !== "personal.projects.named.list")
        throw new Error("Invalid named Project inventory result.");
      return result.data.projects;
    },
    listProjects: async () => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.list",
          input: {}
        })
      );
      if (result.operation !== "personal.projects.list") {
        throw new Error("Invalid Personal Memory Projects result.");
      }
      return result.data.projects;
    },
    listProjectMetadata: async () => {
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.projects.metadata.list",
          input: {}
        })
      );
      if (result.operation !== "personal.projects.metadata.list") {
        throw new Error("Invalid Personal Memory Project metadata result.");
      }
      return result.data.projects;
    },
    loadEventPage: async (
      value: Parameters<PersonalDesktopApi["loadEventPage"]>[0]
    ) => {
      const input = personalDesktopEventPageInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.events.load_page",
          input
        })
      );
      if (result.operation !== "personal.events.load_page") {
        throw new Error("Invalid Personal Memory Events result.");
      }
      return result.data.events;
    },
    updateSessionTitle: async (
      value: Parameters<PersonalDesktopApi["updateSessionTitle"]>[0]
    ) => {
      const input = personalDesktopSessionTitleInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.sessions.update_title",
          input
        })
      );
      if (result.operation !== "personal.sessions.update_title") {
        throw new Error("Invalid Personal Memory title result.");
      }
      return result.data;
    },
    updateSessionPresentation: async (
      value: Parameters<PersonalDesktopApi["updateSessionPresentation"]>[0]
    ) => {
      const input = personalDesktopSessionPresentationInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.sessions.update_presentation",
          input
        })
      );
      if (result.operation !== "personal.sessions.update_presentation") {
        throw new Error("Invalid Personal Memory presentation result.");
      }
      return result.data;
    },
    subscribe: (listener: Parameters<PersonalDesktopApi["subscribe"]>[0]) => {
      if (typeof listener !== "function") {
        throw new TypeError("Personal Memory change listener is required.");
      }
      let active = true;
      const wrapped = (_event: unknown, value: unknown) => {
        if (!active) return;
        const change = personalDesktopChangeSchema.safeParse(value);
        if (change.success) listener(change.data);
      };
      events.on(personalMemoryEventChannel, wrapped);
      return () => {
        active = false;
        events.removeListener(personalMemoryEventChannel, wrapped);
      };
    }
  });
