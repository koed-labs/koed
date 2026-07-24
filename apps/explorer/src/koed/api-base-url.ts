const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTS.has(hostname) || hostname.startsWith("127.");

const browserFlowApiPathPrefix = (pathname: string): string | null => {
  const match = pathname.match(
    /^(.*)\/(?:device-enrollment|high-risk\/browser-activations)\/[^/]+\/?$/
  );
  return match ? (match[1]?.replace(/\/$/, "") ?? "") : null;
};

export const resolveBrowserApiBaseUrl = (
  configuredBaseUrl: string,
  pageHref: string
): string => {
  const normalized = configuredBaseUrl.replace(/\/$/, "");
  try {
    const pageUrl = new URL(pageHref);
    const apiUrl = new URL(normalized);
    const browserFlowPrefix = browserFlowApiPathPrefix(pageUrl.pathname);
    if (
      (pageUrl.protocol === "http:" || pageUrl.protocol === "https:") &&
      browserFlowPrefix !== null
    ) {
      return `${pageUrl.origin}${browserFlowPrefix}`;
    }
    if (
      (pageUrl.protocol === "http:" || pageUrl.protocol === "https:") &&
      !isLoopbackHostname(pageUrl.hostname) &&
      isLoopbackHostname(apiUrl.hostname)
    ) {
      return `${pageUrl.origin}${browserFlowApiPathPrefix(pageUrl.pathname)}`;
    }
  } catch {
    return normalized;
  }
  return normalized;
};
