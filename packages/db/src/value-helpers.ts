export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeDisplayText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const truncateDisplayText = (value: string, maxLength = 280): string => {
  const normalized = normalizeDisplayText(value);
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}...`
    : normalized;
};

export const looksLikeToolPayloadText = (value: string): boolean =>
  /"?toolInput"?\s*:/.test(value) ||
  /"?toolResponse"?\s*:/.test(value) ||
  /^\s*\{\s*"?command"?\s*:/.test(value);
