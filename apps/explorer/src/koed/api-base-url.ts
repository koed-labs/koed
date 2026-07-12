const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname) || hostname.startsWith("127.");

export const resolveBrowserApiBaseUrl = (
  configuredBaseUrl: string,
  pageHref: string
): string => {
  const normalized = configuredBaseUrl.replace(/\/$/, "");
  try {
    const pageUrl = new URL(pageHref);
    const apiUrl = new URL(normalized);
    if (
      (pageUrl.protocol === "http:" || pageUrl.protocol === "https:") &&
      !isLoopbackHostname(pageUrl.hostname) &&
      isLoopbackHostname(apiUrl.hostname)
    ) {
      return pageUrl.origin;
    }
  } catch {
    return normalized;
  }
  return normalized;
};
