import {
  readDesktopLocalCredentialAuthorization,
  workItemsFromDocToolInputSchema
} from "@koed/shared";
import type { MemorySourceRepository } from "@koed/db";

const requestText =
  'Koed work_items_from_doc apply request v1: {"status":"requested"}';
type Event = {
  execution: { id: string; ownerUserId: string; executionGeneration: number };
  command: { id: string; leaseToken: string | null };
  providerTurnId?: string;
  toolCallId?: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
};

/** A tool receipt is never write authority; only this current leased worker may apply. */
export const createWorkItemsFromDocObserver =
  (input: {
    repository: Pick<
      MemorySourceRepository,
      "putManagedConversationRuntimeItem" | "getManagedConversationCommand"
    >;
    apiUrl: string;
    koedHome: string;
    fetch?: typeof fetch;
  }) =>
  async (event: Event): Promise<boolean> => {
    if (event.toolName !== "work_items_from_doc" || !event.command.leaseToken)
      return false;
    const parsedArgs = workItemsFromDocToolInputSchema.safeParse(
      event.arguments
    );
    if (!parsedArgs.success || parsedArgs.data.mode !== "apply") return false;
    const args = parsedArgs.data;
    const current = await input.repository.getManagedConversationCommand(
      { userId: event.execution.ownerUserId },
      event.command.id
    );
    if (
      !current ||
      current.ownerUserId !== event.execution.ownerUserId ||
      current.executionId !== event.execution.id ||
      current.executionGeneration !== event.execution.executionGeneration ||
      current.state !== "dispatching" ||
      current.leaseToken !== event.command.leaseToken ||
      !current.leaseExpiresAt ||
      Date.parse(current.leaseExpiresAt) <= Date.now()
    )
      return false;
    const response =
      event.result &&
      typeof event.result === "object" &&
      !Array.isArray(event.result)
        ? (event.result as Record<string, unknown>)
        : {};
    const receipt = response.structuredContent ?? response.details;
    const blocks = Array.isArray(response.content) ? response.content : [];
    const text =
      blocks.length === 1 && blocks[0] && typeof blocks[0] === "object"
        ? (blocks[0] as { text?: unknown }).text
        : null;
    const structured =
      response.structuredContent !== undefined ||
      response.details !== undefined;
    if (
      response.isError === true ||
      (structured
        ? !receipt ||
          typeof receipt !== "object" ||
          (receipt as { status?: unknown }).status !== "requested"
        : text !== requestText)
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
      `v1/managed-conversations/${event.execution.id}/work-items-from-doc/apply`,
      input.apiUrl.replace(/\/+$/, "/")
    );
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return false;
    const send = input.fetch ?? fetch;
    let accepted = false;
    let statusText =
      "Document Work Item request was not confirmed; refresh the Source and retry from the current Agent turn.";
    try {
      const result = await send(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: desktop.authorization,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          commandId: event.command.id,
          leaseToken: event.command.leaseToken,
          executionGeneration: event.execution.executionGeneration,
          sourceId: args.source_id,
          sourceRevisionId: args.source_revision_id,
          noteRevisionId: args.note_revision_id,
          proposals: args.proposals.map((proposal) => ({
            lineNumber: proposal.line_number,
            sourceLine: proposal.source_line,
            title: proposal.title,
            goal: proposal.goal,
            dueText: proposal.due_text
          })),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }),
        signal: AbortSignal.timeout(30_000)
      });
      accepted = result.ok;
      if (accepted) {
        const body = (await result.json().catch(() => null)) as {
          created?: unknown;
          alreadyExisting?: unknown;
        } | null;
        statusText =
          body &&
          Number.isSafeInteger(body.created) &&
          Number.isSafeInteger(body.alreadyExisting) &&
          Number(body.created) >= 0 &&
          Number(body.alreadyExisting) >= 0
            ? `Koed created ${body.created} Work Items; ${body.alreadyExisting} already had a Work Item for this document revision.`
            : "Document Work Item request accepted. Refresh To do for the result.";
      }
    } catch {
      // The server's idempotency key handles an uncertain response; never replay the tool call.
    }
    try {
      await input.repository.putManagedConversationRuntimeItem(
        { userId: event.execution.ownerUserId },
        {
          executionId: event.execution.id,
          executionGeneration: event.execution.executionGeneration,
          providerRequestId: `work-items-from-doc:${event.command.id}:${event.toolCallId ?? "result"}`,
          ...(event.providerTurnId
            ? { providerTurnId: event.providerTurnId }
            : {}),
          ...(event.toolCallId ? { providerItemId: event.toolCallId } : {}),
          itemKind: "transient_output",
          payload: { text: statusText }
        }
      );
    } catch {
      /* A fenced generation cannot receive a runtime item. */
    }
    return accepted;
  };
