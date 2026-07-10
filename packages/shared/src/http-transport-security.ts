const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

export const assertSecureHttpTransport = (url: URL, label = "URL"): void => {
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error(
    `${label} must use HTTPS unless it targets localhost, 127.0.0.1, or ::1.`
  );
};
