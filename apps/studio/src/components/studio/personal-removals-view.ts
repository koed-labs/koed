export type PersonalRemovalViewTarget =
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; sourceId: string; aliases?: readonly string[] };

export function hasProjectRemoval(
  removals: readonly PersonalRemovalViewTarget[],
  projectId: string
): boolean {
  return removals.some(
    (target) => target.kind === "project" && target.projectId === projectId
  );
}

export function hasConversationRemoval(
  removals: readonly PersonalRemovalViewTarget[],
  sourceIds: readonly (string | null | undefined)[]
): boolean {
  const available = new Set(
    sourceIds.filter((value): value is string => Boolean(value))
  );
  return removals.some(
    (target) =>
      target.kind === "conversation" &&
      (available.has(target.sourceId) ||
        (target.aliases ?? []).some((alias) => available.has(alias)))
  );
}

export function managedConversationRemovalTarget(input: {
  executionId: string;
  providerSourceIds?: readonly string[];
}): PersonalRemovalViewTarget {
  const sourceIds = Array.from(
    new Set(input.providerSourceIds?.filter(Boolean) ?? [])
  );
  const sourceId = sourceIds[0] ?? `managed:${input.executionId}`;
  const aliases = Array.from(
    new Set([`managed:${input.executionId}`, ...sourceIds.slice(1)])
  ).filter((alias) => alias !== sourceId);
  return {
    kind: "conversation",
    sourceId,
    ...(aliases.length > 0 ? { aliases } : {})
  };
}
