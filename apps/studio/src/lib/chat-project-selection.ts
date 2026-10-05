// An explicit null is the user's "No folder" selection. Only an omitted
// selection may inherit the current sidebar Project.
export function newChatProjectId(
  requested: string | null | undefined,
  current: string | null,
  available: ReadonlySet<string>
): string | null {
  return requested === undefined
    ? current && available.has(current)
      ? current
      : null
    : requested;
}
