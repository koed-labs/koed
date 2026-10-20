import type { LcmGraphEvent, ManagedConversationTurnCitation } from "@koed/db";

const aliasPattern = /\[m:(r[0-9a-f]{32}c[1-9][0-9]*)\]/g;

export type MemoryActionSelection =
  | { kind: "selected"; citation: ManagedConversationTurnCitation }
  | { kind: "ask"; reason: "ambiguous" | "unavailable" | "uncited" };

/** Only aliases actually present in an earlier assistant message qualify. */
export const selectManagedMemoryCitation = (input: {
  assistantEvents: readonly LcmGraphEvent[];
  citations: readonly ManagedConversationTurnCitation[];
  userPrompt: string;
  requestedAlias?: string;
  commandCreatedAt: string;
}): MemoryActionSelection => {
  const byAlias = new Map(input.citations.map((item) => [item.alias, item]));
  const earlier = input.assistantEvents
    .filter(
      (event) =>
        (event.actor === "assistant" || event.actor === "agent") &&
        event.content &&
        Date.parse(event.timestamp) < Date.parse(input.commandCreatedAt)
    )
    .sort(
      (a, b) =>
        Date.parse(b.timestamp) - Date.parse(a.timestamp) ||
        (b.sourceSequence ?? -1) - (a.sourceSequence ?? -1)
    );
  const cited: ManagedConversationTurnCitation[] = [];
  const displayedAliasesFor = (event: LcmGraphEvent): string[] =>
    [
      ...new Set(
        [...(event.content ?? "").matchAll(aliasPattern)].map(
          (match) => match[1]!
        )
      )
    ].filter((alias) => byAlias.has(alias));
  for (const event of earlier) {
    const aliases = [...(event.content ?? "").matchAll(aliasPattern)].map(
      (match) => match[1]!
    );
    for (const alias of aliases.reverse()) {
      const citation = byAlias.get(alias);
      if (citation) cited.push(citation);
    }
  }
  const latest = cited[0];
  if (!latest) return { kind: "ask", reason: "uncited" };
  const literalAliases = [
    ...input.userPrompt.matchAll(/r[0-9a-f]{32}c[1-9][0-9]*/g)
  ].map((match) => match[0]);
  if (literalAliases.length > 1) return { kind: "ask", reason: "ambiguous" };
  if (literalAliases.length === 1) {
    const explicit = cited.find((item) => item.alias === literalAliases[0]);
    return explicit
      ? { kind: "selected", citation: explicit }
      : { kind: "ask", reason: "uncited" };
  }
  const latestMessage = earlier[0];
  if (
    latestMessage &&
    [...(latestMessage.content ?? "").matchAll(aliasPattern)].length > 0 &&
    displayedAliasesFor(latestMessage).length === 0
  )
    return { kind: "ask", reason: "uncited" };
  const numbered = [
    ...input.userPrompt.matchAll(
      /\b(?:citation|memory)\s*#?\s*([1-9][0-9]*)\b/gi
    )
  ];
  if (numbered.length > 1) return { kind: "ask", reason: "ambiguous" };
  if (numbered.length === 1) {
    const ordinal = Number(numbered[0]![1]);
    const specifiedLatest = /\b(?:latest|last|most recent)\b/i.test(
      input.userPrompt
    );
    const latestCitedMessage = earlier.find(
      (event) => displayedAliasesFor(event).length > 0
    );
    if (specifiedLatest) {
      const target = latestCitedMessage
        ? displayedAliasesFor(latestCitedMessage)[ordinal - 1]
        : undefined;
      const citation = target ? byAlias.get(target) : undefined;
      return citation
        ? { kind: "selected", citation }
        : { kind: "ask", reason: "uncited" };
    }
    const matchingMessages = earlier.filter(
      (event) => displayedAliasesFor(event).length >= ordinal
    );
    if (matchingMessages.length > 1)
      return { kind: "ask", reason: "ambiguous" };
    const chosen = matchingMessages[0];
    const target = chosen
      ? displayedAliasesFor(chosen)[ordinal - 1]
      : undefined;
    const citation = target ? byAlias.get(target) : undefined;
    return citation
      ? { kind: "selected", citation }
      : { kind: "ask", reason: "uncited" };
  }
  if (!/\b(that|this|it)\b/i.test(input.userPrompt))
    return { kind: "ask", reason: "ambiguous" };
  // A model-supplied alias has no authority to redirect an unqualified User
  // request away from the latest actually cited source.
  if (input.requestedAlias && input.requestedAlias !== latest.alias)
    return { kind: "ask", reason: "ambiguous" };
  return { kind: "selected", citation: latest };
};
