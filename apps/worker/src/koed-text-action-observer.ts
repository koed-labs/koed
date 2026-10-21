import type { MemorySourceRepository } from "@koed/db";
import {
  koedTextActionDeliverySchema,
  koedTextActionInputSchemas,
  koedTextActionReceipt,
  readDesktopLocalCredentialAuthorization,
  type KoedTextActionName
} from "@koed/shared";

type Event = {
  execution: { id: string; ownerUserId: string; executionGeneration: number };
  command: { id: string; leaseToken: string | null };
  providerTurnId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
};

const receiptValid = (name: KoedTextActionName, value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.isError === true) return false;
  const structured = result.structuredContent ?? result.details;
  if (structured !== undefined)
    return (
      !!structured &&
      typeof structured === "object" &&
      !Array.isArray(structured) &&
      (structured as Record<string, unknown>).status === "requested"
    );
  const content: unknown = result.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const first: unknown = content[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return false;
  const block = first as Record<string, unknown>;
  return block.type === "text" && block.text === koedTextActionReceipt(name);
};

/** A provider tool result has no write authority; only the current local lease may deliver it. */
export const createKoedTextActionObserver =
  (input: {
    repository: Pick<MemorySourceRepository, "getManagedConversationCommand">;
    apiUrl: string;
    koedHome: string;
    fetch?: typeof fetch;
  }) =>
  async (event: Event): Promise<boolean> => {
    if (
      !Object.hasOwn(koedTextActionInputSchemas, event.toolName) ||
      !event.command.leaseToken
    )
      return false;
    const name = event.toolName as KoedTextActionName;
    if (!receiptValid(name, event.result)) return false;
    const args = koedTextActionInputSchemas[name].safeParse(event.arguments);
    if (!args.success) return false;
    const current = await input.repository.getManagedConversationCommand(
      { userId: event.execution.ownerUserId },
      event.command.id
    );
    if (
      !current ||
      current.ownerUserId !== event.execution.ownerUserId ||
      current.executionId !== event.execution.id ||
      (current.commandKind !== "prompt" && current.commandKind !== "start") ||
      current.executionGeneration !== event.execution.executionGeneration ||
      current.state !== "dispatching" ||
      current.leaseToken !== event.command.leaseToken ||
      !current.leaseExpiresAt ||
      Date.parse(current.leaseExpiresAt) <= Date.now() ||
      typeof current.payload?.prompt !== "string"
    )
      return false;
    const desktop = readDesktopLocalCredentialAuthorization(input.koedHome);
    if (
      !desktop ||
      desktop.ownerUserId !== event.execution.ownerUserId ||
      !desktop.operationFamilies.includes("personal_collaboration_write") ||
      !desktop.operationFamilies.includes("managed_execution")
    )
      return false;
    const url = new URL(
      `v1/managed-conversations/${event.execution.id}/text-actions`,
      input.apiUrl.replace(/\/+$/, "/")
    );
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return false;
    const body = koedTextActionDeliverySchema.parse({
      name,
      arguments: args.data,
      executionGeneration: event.execution.executionGeneration,
      commandId: event.command.id,
      leaseToken: event.command.leaseToken,
      providerTurnId: event.providerTurnId,
      toolCallId: event.toolCallId
    });
    try {
      const response = await (input.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: desktop.authorization,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(body)
      });
      return response.ok;
    } catch {
      // An uncertain HTTP result is never a reason to repeat an effect here.
      return false;
    }
  };
