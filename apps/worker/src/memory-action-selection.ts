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
  const citedAliases: string[] = [];
  const displayedAliasesFor = (event: LcmGraphEvent): string[] => [
    ...new Set(
      [...(event.content ?? "").matchAll(aliasPattern)].map(
        (match) => match[1]!
      )
    )
  ];
  for (const event of earlier) {
    const aliases = [...(event.content ?? "").matchAll(aliasPattern)].map(
      (match) => match[1]!
    );
    citedAliases.push(...aliases.reverse());
  }
  const latestAlias = citedAliases[0];
  if (!latestAlias) return { kind: "ask", reason: "uncited" };
  const literalAliases = [
    ...input.userPrompt.matchAll(/r[0-9a-f]{32}c[1-9][0-9]*/g)
  ].map((match) => match[0]);
  if (literalAliases.length > 1) return { kind: "ask", reason: "ambiguous" };
  if (literalAliases.length === 1) {
    const explicit = citedAliases.includes(literalAliases[0]!)
      ? byAlias.get(literalAliases[0]!)
      : undefined;
    return explicit
      ? { kind: "selected", citation: explicit }
      : { kind: "ask", reason: "uncited" };
  }
  const latestCitedMessage = earlier.find(
    (event) => displayedAliasesFor(event).length > 0
  );
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
    // A number absent from the latest cited answer cannot silently select
    // an older answer, even when that older number is currently resolvable.
    if (
      !latestCitedMessage ||
      displayedAliasesFor(latestCitedMessage).length < ordinal
    )
      return { kind: "ask", reason: "uncited" };
    if (matchingMessages.length > 1)
      return { kind: "ask", reason: "ambiguous" };
    const target = displayedAliasesFor(latestCitedMessage)[ordinal - 1];
    const citation = target ? byAlias.get(target) : undefined;
    return citation
      ? { kind: "selected", citation }
      : { kind: "ask", reason: "uncited" };
  }
  if (!/\b(that|this|it)\b/i.test(input.userPrompt))
    return { kind: "ask", reason: "ambiguous" };
  // A model-supplied alias has no authority to redirect an unqualified User
  // request away from the latest actually cited source.
  if (input.requestedAlias && input.requestedAlias !== latestAlias)
    return { kind: "ask", reason: "ambiguous" };
  const latest = byAlias.get(latestAlias);
  return latest
    ? { kind: "selected", citation: latest }
    : { kind: "ask", reason: "uncited" };
};
