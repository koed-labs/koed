import type { Agent } from "@koed/shared/agent-contract";

export type MentionResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "matched"; agent: Agent; task: string };

/** Only a leading, exact owned Agent name is an executable mention. */
export function resolveAgentMention(
  text: string,
  agents: readonly Agent[]
): MentionResult {
  const input = text.trimStart();
  if (!input.startsWith("@")) return { kind: "none" };
  const matches = agents.filter(
    (agent) =>
      !agent.isChiefOfStaff &&
      input
        .toLocaleLowerCase()
        .startsWith(`@${agent.name.toLocaleLowerCase()}`) &&
      /^\s/u.test(input.slice(agent.name.length + 1, agent.name.length + 2))
  );
  if (matches.length !== 1)
    return {
      kind: "invalid",
      message: matches.length
        ? "Agent mention is ambiguous. Choose a unique Agent name."
        : "That Helper Agent is unavailable. Choose an Agent from your list."
    };
  const task = input.slice(matches[0]!.name.length + 1).trim();
  return task
    ? { kind: "matched", agent: matches[0]!, task }
    : { kind: "invalid", message: "Add the work you want this Agent to do." };
}

const keyFor = (identity: string) => `hq-agent-delegation:${identity}`;
const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

export async function pendingDelegationRequestId(
  identity: string,
  agentId: string,
  task: string
): Promise<string> {
  const digest = hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([agentId, task]))
    )
  );
  const key = keyFor(identity);
  try {
    const previous = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      "digest" in previous &&
      previous.digest === digest &&
      "requestId" in previous &&
      typeof previous.requestId === "string" &&
      /^agent-delegation:[0-9a-f-]{36}$/.test(previous.requestId)
    )
      return previous.requestId;
  } catch {
    /* A malformed local marker cannot grant a child launch. */
  }
  const requestId = `agent-delegation:${crypto.randomUUID()}`;
  localStorage.setItem(key, JSON.stringify({ digest, requestId }));
  return requestId;
}

export function clearPendingDelegation(
  identity: string,
  requestId: string
): void {
  const key = keyFor(identity);
  try {
    const previous = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      "requestId" in previous &&
      previous.requestId === requestId
    )
      localStorage.removeItem(key);
  } catch {
    localStorage.removeItem(key);
  }
}
