export const isExplorerApiProxyPath = (url: string | undefined): boolean => {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return (
    pathname === "/me" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/v1/")
  );
};

export const resolveExplorerApiProxyTarget = (
  requestUrl: string | undefined,
  apiUrl: URL
): URL => {
  const incoming = new URL(requestUrl ?? "/", "http://localhost");
  const target = new URL(apiUrl);
  const basePath = target.pathname.replace(/\/$/, "");
  target.pathname = `${basePath}${incoming.pathname}`;
  target.search = incoming.search;
  target.hash = "";
  return target;
};
