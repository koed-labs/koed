import {
  PERSONAL_DESKTOP_CONTRACT_VERSION,
  personalDesktopChangeSchema,
  personalDesktopEventPageInputSchema,
  personalDesktopRequestSchema,
  personalDesktopResultSchema,
  personalDesktopSessionProjectInputSchema,
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
    assignSessionProject: async (
      value: Parameters<PersonalDesktopApi["assignSessionProject"]>[0]
    ) => {
      const input = personalDesktopSessionProjectInputSchema.parse(value);
      const result = requireSuccess(
        await invokePersonalMemory(invoke, {
          contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
          operation: "personal.sessions.assign_project",
          input
        })
      );
      if (result.operation !== "personal.sessions.assign_project") {
        throw new Error("Invalid Personal Memory assignment result.");
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
