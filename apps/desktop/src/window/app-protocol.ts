import { pathToFileURL } from "node:url";
import { join, relative, isAbsolute, extname } from "node:path";

export const KOED_APP_SCHEME = "koed";

export interface AppProtocolRequestResolution {
  kind: "file" | "redirect" | "not_found";
  fileUrl?: string;
  redirectUrl?: string;
  status?: number;
}

export const isUnsafeRelativePath = (
  appDistDir: string,
  filePath: string
): boolean => {
  const relativePath = relative(appDistDir, filePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
};

export const resolveAppProtocolRequest = (
  appDistDir: string,
  requestUrl: string
): AppProtocolRequestResolution => {
  if (/%2e|%2f|%5c/i.test(requestUrl)) {
    return { kind: "not_found", status: 404 };
  }

  const { pathname, search, hash } = new URL(requestUrl);
  const decodedPath = decodeURIComponent(pathname);

  if (decodedPath.endsWith("/index.html")) {
    const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
    return {
      kind: "redirect",
      redirectUrl: `${KOED_APP_SCHEME}://app${normalizedPath}${search}${hash}`,
      status: 307
    };
  }

  const filePath = join(appDistDir, decodedPath);
  if (isUnsafeRelativePath(appDistDir, filePath)) {
    return { kind: "not_found", status: 404 };
  }

  if (!relative(appDistDir, filePath) || !extname(filePath)) {
    return {
      kind: "file",
      fileUrl: pathToFileURL(join(appDistDir, "index.html")).toString()
    };
  }

  return { kind: "file", fileUrl: pathToFileURL(filePath).toString() };
};
