export const flattenContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
};

export const clip = (text: string, maxLength = 12_000): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated]`;
