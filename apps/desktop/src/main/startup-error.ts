const secretPattern =
  /(Bearer\s+\S+|(?:API_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*[:=]\s*\S+)/giu;

export const formatDesktopStartupError = (error: unknown): string => {
  const message =
    error instanceof Error
      ? error.stack || error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  return String(message || "Unknown desktop startup failure")
    .replace(secretPattern, "[REDACTED_SECRET]")
    .slice(0, 16_000);
};
