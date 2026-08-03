#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, normalize, resolve, sep } from "node:path";
import {
  isExplorerApiProxyPath,
  resolveExplorerApiProxyTarget
} from "./explorer-static-proxy.js";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const argValue = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value?.trim() ? value : fallback;
};

const distDir = resolve(process.argv[2] ?? ".");
const host = argValue("--host", "127.0.0.1");
const port = Number.parseInt(argValue("--port", "5174"), 10);
const apiUrl = new URL(argValue("--api-url", "http://127.0.0.1:3300"));
if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
  throw new Error("Explorer API proxy URL must use http or https.");
}

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const proxyApiRequest = (
  request: IncomingMessage,
  response: ServerResponse
): void => {
  const target = resolveExplorerApiProxyTarget(request.url, apiUrl);
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(
      ([name]) => !hopByHopHeaders.has(name.toLowerCase())
    )
  );
  headers.host = target.host;

  const proxyRequest = (
    target.protocol === "https:" ? httpsRequest : httpRequest
  )(
    target,
    {
      method: request.method,
      headers
    },
    (proxyResponse) => {
      const responseHeaders = Object.fromEntries(
        Object.entries(proxyResponse.headers).filter(
          ([name]) => !hopByHopHeaders.has(name.toLowerCase())
        )
      );
      response.writeHead(proxyResponse.statusCode ?? 502, responseHeaders);
      proxyResponse.pipe(response);
    }
  );
  proxyRequest.setTimeout(30_000, () => {
    proxyRequest.destroy(new Error("Explorer API proxy timed out."));
  });
  proxyRequest.once("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Koed API is unavailable.\n");
  });
  request.pipe(proxyRequest);
};

const resolveRequestPath = (url: string | undefined): string => {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = resolve(distDir, relative);
  if (candidate !== distDir && !candidate.startsWith(`${distDir}${sep}`)) {
    return join(distDir, "index.html");
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  return join(distDir, "index.html");
};

const server = createServer((request, response) => {
  if (isExplorerApiProxyPath(request.url)) {
    proxyApiRequest(request, response);
    return;
  }
  const filePath = resolveRequestPath(request.url);
  if (!existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Koed Explorer build is missing.\n");
    return;
  }
  response.writeHead(200, {
    "content-type":
      contentTypes[extname(filePath)] ?? "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(
    `Koed Explorer static server listening at http://${host}:${port}`
  );
});
