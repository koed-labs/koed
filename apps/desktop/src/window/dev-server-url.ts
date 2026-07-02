const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isLoopbackHostname = (hostname: string): boolean => {
  if (LOOPBACK_HOSTS.has(hostname)) {
    return true;
  }
  return hostname.startsWith("127.");
};

export const resolveDevServerUrl = ({
  appIsPackaged,
  devServerUrl
}: {
  appIsPackaged: boolean;
  devServerUrl?: string;
}): string | null => {
  const trimmed = devServerUrl?.trim();
  if (!trimmed || appIsPackaged) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (!isLoopbackHostname(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};
