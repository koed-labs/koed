export type RequiredModelKind = "embedding" | "privacy";

/** Respect the distinct status contracts returned by the two model runtimes. */
export const requiredModelStatusInstalled = (
  kind: RequiredModelKind,
  value: unknown
): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if (
    status.state !== "installed" ||
    typeof status.message !== "string" ||
    !status.message.trim() ||
    typeof status.modelPath !== "string" ||
    !status.modelPath.trim()
  )
    return false;
  if (kind === "privacy") return status.ok === true;
  return status.ok === undefined || status.ok === true;
};
