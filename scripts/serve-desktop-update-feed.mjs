import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactNamesForVersion,
  validateDesktopUpdateArtifacts
} from "./desktop-update-artifacts-lib.mjs";

export async function startDesktopUpdateFeed({
  root,
  version = null,
  host = "127.0.0.1",
  port = 0,
  prefix = "/"
} = {}) {
  const result = validateDesktopUpdateArtifacts({
    root,
    expectedVersion: version
  });
  const normalizedPrefix = normalizePrefix(prefix);
  const allowed = new Set(artifactNamesForVersion(result.version));
  const feedRoot = resolve(result.root);
  const feedRootReal = realpathSync(feedRoot);
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      return response.end();
    }
    const requestUrl = new URL(request.url ?? "/", "http://koed.internal");
    if (requestUrl.pathname === `${normalizedPrefix}healthz`) {
      return sendJson(response, 200, {
        ok: true,
        ready: true,
        version: result.version,
        trust: result.trust
      });
    }
    if (!requestUrl.pathname.startsWith(normalizedPrefix))
      return sendNotFound(response);
    const encodedName = requestUrl.pathname.slice(normalizedPrefix.length);
    let name;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      return sendNotFound(response);
    }
    // electron-updater requests `<channel>-mac.yml` when the coordinator
    // selects a non-default channel. The packaged generic feed emits the
    // canonical latest-mac.yml; map the internal stable channel explicitly.
    if (name === "stable-mac.yml" && allowed.has("latest-mac.yml"))
      name = "latest-mac.yml";
    if (
      !name ||
      name.includes("/") ||
      name.includes("\\") ||
      name === "." ||
      name === ".." ||
      !allowed.has(name)
    ) {
      return sendNotFound(response);
    }
    let filePath;
    try {
      filePath = safeCandidatePath(feedRoot, feedRootReal, name);
    } catch {
      return sendNotFound(response);
    }
    const size = statSync(filePath).size;
    const contentType = name.endsWith(".yml")
      ? "text/yaml; charset=utf-8"
      : "application/octet-stream";
    const ranges = parseByteRanges(request.headers.range, size);
    const commonHeaders = {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-type": contentType
    };
    if (ranges.length === 0 && request.headers.range) {
      response.writeHead(416, {
        ...commonHeaders,
        "content-range": `bytes */${size}`,
        "content-length": "0"
      });
      return response.end();
    }
    if (ranges.length === 0) {
      response.writeHead(200, { ...commonHeaders, "content-length": size });
      return request.method === "HEAD"
        ? response.end()
        : response.end(readFileSync(filePath));
    }
    if (ranges.length === 1) {
      const range = ranges[0];
      response.writeHead(206, {
        ...commonHeaders,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": range.end - range.start + 1
      });
      if (request.method === "HEAD") return response.end();
      return response.end(
        readFileSync(filePath).subarray(range.start, range.end + 1)
      );
    }
    const boundary = `koed-${name.replace(/[^A-Za-z0-9]/g, "-")}`;
    const parts = ranges.map((range) => {
      const header = `--${boundary}\r\nContent-Range: bytes ${range.start}-${range.end}/${size}\r\nContent-Type: ${contentType}\r\n\r\n`;
      return { range, header };
    });
    const ending = `--${boundary}--\r\n`;
    const contentLength = parts.reduce(
      (total, part) =>
        total +
        Buffer.byteLength(part.header) +
        part.range.end -
        part.range.start +
        3,
      Buffer.byteLength(ending)
    );
    response.writeHead(206, {
      ...commonHeaders,
      "content-type": `multipart/byteranges; boundary=${boundary}`,
      "content-length": contentLength
    });
    if (request.method === "HEAD") return response.end();
    const body = readFileSync(filePath);
    const chunks = [];
    for (const part of parts) {
      chunks.push(Buffer.from(part.header));
      chunks.push(body.subarray(part.range.start, part.range.end + 1));
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(ending));
    return response.end(Buffer.concat(chunks));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  return {
    server,
    info: {
      ready: true,
      host,
      port: actualPort,
      feed_url: `http://${host}:${actualPort}${normalizedPrefix}`,
      health_url: `http://${host}:${actualPort}${normalizedPrefix}healthz`,
      version: result.version,
      channel: result.channel,
      trust: result.trust,
      artifacts: result.artifacts
    }
  };
}

function safeCandidatePath(root, rootReal, name) {
  const rootInfo = lstatSync(root);
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    realpathSync(root) !== rootReal
  ) {
    throw new Error("Unsafe feed candidate root");
  }
  const path = resolve(root, name);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Unsafe feed artifact: ${name}`);
  const real = realpathSync(path);
  const rel = relative(rootReal, real);
  if (!rel || rel.startsWith(".."))
    throw new Error(`Feed artifact escapes candidate root: ${name}`);
  return path;
}

export function parseByteRanges(header, size) {
  if (!header) return [];
  if (typeof header !== "string" || !header.startsWith("bytes=")) return [];
  const ranges = [];
  for (const raw of header.slice(6).split(",")) {
    const value = raw.trim();
    const match = /^(\d*)-(\d*)$/.exec(value);
    if (!match) continue;
    const startValue = match[1];
    const endValue = match[2];
    let start;
    let end;
    if (!startValue && !endValue) continue;
    if (!startValue) {
      const suffix = Number(endValue);
      if (!Number.isInteger(suffix) || suffix <= 0) continue;
      start = Math.max(size - suffix, 0);
      end = size - 1;
    } else {
      start = Number(startValue);
      end = endValue ? Number(endValue) : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= size
      )
        continue;
      end = Math.min(end, size - 1);
    }
    if (size > 0 && start <= end) ranges.push({ start, end });
  }
  return ranges;
}

function normalizePrefix(prefix) {
  if (
    typeof prefix !== "string" ||
    !prefix.startsWith("/") ||
    prefix.includes("..") ||
    prefix.includes("\\")
  ) {
    throw new Error("prefix must be an absolute URL path without traversal");
  }
  return prefix === "/" ? "/" : `/${prefix.replace(/^\/+|\/+$/g, "")}/`;
}

function sendNotFound(response) {
  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ ok: false, error: "not_found" }));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      version: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "0" },
      prefix: { type: "string", default: "/" },
      json: { type: "boolean", default: false }
    },
    strict: true
  });
  try {
    const { info } = await startDesktopUpdateFeed({
      root: values.root,
      version: values.version ?? null,
      host: values.host,
      port: Number(values.port),
      prefix: values.prefix
    });
    process.stdout.write(`${JSON.stringify(info)}\n`);
  } catch (error) {
    process.stderr.write(`Desktop updater feed failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
