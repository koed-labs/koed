const allowedExternalProtocols = new Set(["http:", "https:", "mailto:"]);

export const parseExternalUrl = (value: string): URL | null => {
  if (!value || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (!allowedExternalProtocols.has(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.hostname
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

export const safeExternalUrl = (value: string): string | null =>
  parseExternalUrl(value)?.toString() ?? null;
