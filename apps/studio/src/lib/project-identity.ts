/** Runtime UUIDs are not stable, human-selected Project identities. */
export function isSyntheticIndependentProject(
  projectId: string | null | undefined,
  projectName?: string | null
): boolean {
  const isRuntimeUuid = (value: string | null | undefined) =>
    Boolean(
      value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.trim()
      )
    );
  if (/^lp_[0-9a-f]{32}$/iu.test(projectId ?? "")) return false;
  return isRuntimeUuid(projectId) || isRuntimeUuid(projectName);
}
