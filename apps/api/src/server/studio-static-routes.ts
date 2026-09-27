import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const studioPrefix = "/studio";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const setStudioHeaders = (reply: FastifyReply, html: boolean): void => {
  reply
    .header(
      "content-security-policy",
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
    )
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), geolocation=(), microphone=()")
    .header("referrer-policy", "strict-origin-when-cross-origin")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("cache-control", html ? "no-cache" : "public, max-age=3600");
};

const decodeStudioRelativePath = (request: FastifyRequest): string | null => {
  const rawUrl = request.raw.url ?? studioPrefix;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://koed.invalid").pathname;
  } catch {
    return null;
  }

  if (pathname === studioPrefix || pathname === `${studioPrefix}/`) return "";
  if (!pathname.startsWith(`${studioPrefix}/`)) return null;

  let decoded = pathname.slice(studioPrefix.length + 1);
  // URL parsing leaves percent escapes intact. Decode repeatedly so nested
  // encodings cannot disguise a dot segment or path separator.
  for (let attempt = 0; attempt < 3 && decoded.includes("%"); attempt += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }

  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return null;
  }

  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return decoded.replace(/\/+$/, "");
};

const pathIsWithin = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
};

const resolveStaticFile = async (
  assetRoot: string,
  relativePath: string
): Promise<{ file: string } | "root-missing" | null> => {
  let root: string;
  try {
    root = await realpath(resolve(assetRoot));
  } catch {
    return "root-missing";
  }

  const candidates = relativePath
    ? [
        relativePath,
        ...(extname(relativePath)
          ? []
          : [`${relativePath}.html`, `${relativePath}/index.html`])
      ]
    : ["index.html"];
  for (const candidatePath of candidates) {
    const candidate = resolve(root, candidatePath);
    if (!pathIsWithin(root, candidate)) continue;
    try {
      const file = await realpath(candidate);
      if (!pathIsWithin(root, file)) continue;
      if (!(await stat(file)).isFile()) continue;
      return { file };
    } catch {
      // Try the next canonical static-export form, then return a not-found.
    }
  }
  return null;
};

const sendStudioFile = async (
  request: FastifyRequest,
  reply: FastifyReply,
  assetRoot: string
) => {
  const relativePath = decodeStudioRelativePath(request);
  if (relativePath === null) {
    setStudioHeaders(reply, false);
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }

  const resolved = await resolveStaticFile(assetRoot, relativePath);
  if (resolved === "root-missing") {
    setStudioHeaders(reply, false);
    return reply
      .code(503)
      .type("text/plain; charset=utf-8")
      .send("Studio is unavailable");
  }
  if (!resolved) {
    setStudioHeaders(reply, false);
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }

  const ext = extname(resolved.file).toLowerCase();
  const contentType = contentTypes[ext];
  if (!contentType) {
    setStudioHeaders(reply, false);
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }

  const isHtmlOrNextPayload = ext === ".html" || ext === ".txt";
  setStudioHeaders(reply, isHtmlOrNextPayload);
  if (relativePath.startsWith("_next/static/")) {
    reply.header("cache-control", "public, max-age=31536000, immutable");
  }
  try {
    const content = await readFile(resolved.file);
    return reply.type(contentType).send(content);
  } catch {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }
};

/** Register the hosted Studio static export when its asset root is configured. */
export const registerStudioStaticRoutes = (
  app: FastifyInstance,
  options: { assetRoot?: string } = {}
): void => {
  const assetRoot =
    options.assetRoot?.trim() || process.env.KOED_STUDIO_STATIC_ROOT?.trim();
  if (!assetRoot) return;

  const handler = (request: FastifyRequest, reply: FastifyReply) =>
    sendStudioFile(request, reply, assetRoot);

  // Fastify exposes HEAD automatically for GET routes.
  app.route({ method: "GET", url: studioPrefix, handler });
  app.route({ method: "GET", url: `${studioPrefix}/`, handler });
  app.route({ method: "GET", url: `${studioPrefix}/*`, handler });
};
