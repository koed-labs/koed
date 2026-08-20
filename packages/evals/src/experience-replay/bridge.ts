import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createMcpHandler,
  validateHostHeader,
  type AuthInfo
} from "@modelcontextprotocol/server";
import {
  createKoedMcpServer,
  KOED_MCP_PROTOCOL_VERSION,
  LOCAL_AI_RUNTIME_DEFAULT_MAX_ACTIVE_ANSWERS,
  LOCAL_AI_RUNTIME_MAX_BODY_BYTES,
  LocalAiRuntimeClient
} from "@koed/mcp-server/runtime-contracts";
import {
  BridgeTelemetryCollector,
  registerBridgeTelemetry,
  type BridgeCallTelemetry
} from "./bridge-telemetry.js";
import type { MemoryReplayCondition } from "./core/schedule.js";

const equal = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const readBoundedBody = async (
  request: http.IncomingMessage
): Promise<Uint8Array | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > LOCAL_AI_RUNTIME_MAX_BODY_BYTES) {
    request.resume();
    throw Object.assign(new Error("Request body is too large"), {
      status: 413
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      throw new Error("Request body contained an invalid stream chunk");
    }
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > LOCAL_AI_RUNTIME_MAX_BODY_BYTES) {
      request.resume();
      throw Object.assign(new Error("Request body is too large"), {
        status: 413
      });
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const writeResponse = async (
  source: Response,
  target: http.ServerResponse
): Promise<void> => {
  target.writeHead(source.status, Object.fromEntries(source.headers.entries()));
  if (!source.body) {
    target.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(source.body as never)
      .once("error", reject)
      .once("end", resolve)
      .pipe(target);
  });
};

export interface TrialBridgeIdentity {
  runId: string;
  trialId: string;
  taskDigest: string;
  condition: MemoryReplayCondition;
}

const privateIpv4 = (value: string): boolean => {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

export const resolveDockerBridgeHost = (): string => "host.docker.internal";

class TrialCredential {
  constructor(readonly identity: TrialBridgeIdentity) {}
  readonly id = randomUUID();
  readonly token = randomBytes(32).toString("base64url");
  private activatedAt?: number;
  private expiresAt?: number;
  private revokedAt?: number;

  activate(lifetimeMs: number, now = Date.now()): void {
    if (this.activatedAt || this.revokedAt) {
      throw new Error("Trial credential cannot be activated twice");
    }
    if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0) {
      throw new Error("Trial credential lifetime must be positive");
    }
    this.activatedAt = now;
    this.expiresAt = now + lifetimeMs;
  }

  revoke(now = Date.now()): void {
    this.revokedAt ??= now;
  }

  authorize(
    header: string | undefined,
    now = Date.now()
  ): AuthInfo | undefined {
    if (
      !this.activatedAt ||
      !this.expiresAt ||
      this.revokedAt ||
      now >= this.expiresAt
    ) {
      return undefined;
    }
    const expected = `Bearer ${this.token}`;
    if (!header || !equal(header, expected)) return undefined;
    return {
      token: this.token,
      clientId: `koed-experience-replay:${this.identity.trialId}:${this.id}`,
      scopes: ["memory:answer"],
      expiresAt: Math.floor(this.expiresAt / 1_000)
    };
  }

  get attestation() {
    return {
      id: this.id,
      identity: this.identity,
      activatedAt: this.activatedAt,
      expiresAt: this.expiresAt,
      revokedAt: this.revokedAt
    };
  }
}

export interface BenchmarkBridgeHandle {
  url: string;
  containerUrl?: string;
  token: string;
  credentialId: string;
  activate(lifetimeMs: number): void;
  revoke(): void;
  attestation(): {
    id: string;
    identity: TrialBridgeIdentity;
    activatedAt?: number;
    expiresAt?: number;
    revokedAt?: number;
  };
  telemetry(): BridgeCallTelemetry;
  close(): Promise<void>;
}

export const isBenchmarkDockerPeer = (address: string): boolean => {
  const match = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(address);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
};

export const startBenchmarkBridge = async ({
  runtimeClient,
  projectCwd,
  trialWorkspaceRoot,
  identity,
  host = "127.0.0.1",
  port = 0,
  allowedRemoteAddresses = ["127.0.0.1", "::1"],
  maxActiveRequests = LOCAL_AI_RUNTIME_DEFAULT_MAX_ACTIVE_ANSWERS,
  requestTimeoutMs = 120_000,
  isolatedInterfaceAddress,
  dockerAccess = false,
  dockerHost,
  now = Date.now
}: {
  runtimeClient: LocalAiRuntimeClient;
  projectCwd: string;
  trialWorkspaceRoot: string;
  identity: TrialBridgeIdentity;
  host?: string;
  port?: number;
  allowedRemoteAddresses?: readonly string[];
  maxActiveRequests?: number;
  requestTimeoutMs?: number;
  isolatedInterfaceAddress?: string;
  dockerAccess?: boolean;
  dockerHost?: string;
  now?: () => number;
}): Promise<BenchmarkBridgeHandle> => {
  if (!path.isAbsolute(projectCwd) || !path.isAbsolute(trialWorkspaceRoot)) {
    throw new Error(
      "Benchmark Project cwd and trial workspace root must be absolute"
    );
  }
  const lexicalRoot = path.resolve(trialWorkspaceRoot);
  const lexicalProject = path.resolve(projectCwd);
  const relativeProject = path.relative(lexicalRoot, lexicalProject);
  if (
    !relativeProject ||
    relativeProject === ".." ||
    relativeProject.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeProject)
  ) {
    throw new Error(
      "Benchmark Project cwd must be beneath the trial workspace root"
    );
  }
  let canonicalRoot: string;
  let canonicalProject: string;
  try {
    const rootInfo = await lstat(lexicalRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("unsafe root");
    }
    canonicalRoot = await realpath(lexicalRoot);
    let current = canonicalRoot;
    for (const component of relativeProject.split(path.sep)) {
      current = path.join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("symlink");
    }
    const projectInfo = await lstat(current);
    if (!projectInfo.isDirectory()) throw new Error("not a directory");
    canonicalProject = await realpath(current);
  } catch {
    throw new Error(
      "Benchmark Project cwd and trial workspace root must exist as real directories without symlinks"
    );
  }
  const canonicalRelative = path.relative(canonicalRoot, canonicalProject);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(
      "Benchmark Project cwd must be beneath the trial workspace root"
    );
  }
  if (dockerAccess && host !== "127.0.0.1") {
    throw new Error("Docker-accessible bridge controls its own bind address");
  }
  const containerHost = dockerAccess
    ? (dockerHost ?? resolveDockerBridgeHost())
    : null;
  if (
    containerHost &&
    containerHost !== "host.docker.internal" &&
    !privateIpv4(containerHost)
  ) {
    throw new Error(
      "Docker benchmark bridge host must be private IPv4 or host.docker.internal"
    );
  }
  const bindHost = dockerAccess ? "0.0.0.0" : host;
  const loopbackHost = bindHost === "127.0.0.1" || bindHost === "::1";
  if (!loopbackHost && !dockerAccess && isolatedInterfaceAddress !== bindHost) {
    throw new Error(
      "Benchmark bridge must bind loopback or one explicitly attested isolated interface"
    );
  }
  if (!Number.isInteger(maxActiveRequests) || maxActiveRequests < 1) {
    throw new Error("Benchmark bridge maxActiveRequests must be positive");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("Benchmark bridge requestTimeoutMs must be positive");
  }
  const allowedPeers = new Set(
    allowedRemoteAddresses.flatMap((address) => [address, `::ffff:${address}`])
  );
  if (!identity.runId || !identity.trialId || !identity.taskDigest) {
    throw new Error("Benchmark bridge requires complete trial identity");
  }
  const credential = new TrialCredential(Object.freeze({ ...identity }));
  const telemetry = new BridgeTelemetryCollector();
  const handler = createMcpHandler(
    (requestContext) =>
      createKoedMcpServer(requestContext, {
        runtimeClient,
        callerContextResolver: ({ defaultContext }) => {
          if (defaultContext.protocolVersion !== KOED_MCP_PROTOCOL_VERSION) {
            throw new Error("Benchmark bridge requires MCP 2026-07-28");
          }
          return { ...defaultContext, cwd: canonicalProject };
        }
      }),
    { legacy: "reject" }
  );
  let expectedOrigin = "";
  const activeRequests = new Set<AbortController>();
  const server = http.createServer((request, response) => {
    void (async () => {
      if (
        !request.socket.remoteAddress ||
        (!allowedPeers.has(request.socket.remoteAddress) &&
          !(
            dockerAccess && isBenchmarkDockerPeer(request.socket.remoteAddress)
          ))
      ) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Unapproved trial peer" }));
        return;
      }
      const hostValidation = validateHostHeader(request.headers.host, [
        host,
        ...(containerHost ? [containerHost] : [])
      ]);
      if (!hostValidation.ok) {
        response.writeHead(421, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid Host header" }));
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== expectedOrigin) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid Origin header" }));
        return;
      }
      const authInfo = credential.authorize(
        request.headers.authorization,
        now()
      );
      if (!authInfo) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="koed-experience-replay"'
        });
        response.end(JSON.stringify({ error: "Invalid trial credential" }));
        return;
      }
      if (activeRequests.size >= maxActiveRequests) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1"
        });
        response.end(JSON.stringify({ error: "Bridge request limit reached" }));
        return;
      }
      const abort = new AbortController();
      activeRequests.add(abort);
      const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
      timeout.unref();
      request.once("aborted", () => abort.abort());
      response.once("close", () => abort.abort());
      try {
        const body = await readBoundedBody(request);
        if (!request.url?.startsWith("/")) {
          throw Object.assign(
            new Error("Absolute-form request targets are not allowed"),
            {
              status: 400
            }
          );
        }
        const url = new URL(request.url ?? "/", expectedOrigin);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const webRequest = new Request(url, {
          method: request.method,
          headers,
          body: body ? Buffer.from(body).toString("utf8") : undefined,
          signal: abort.signal
        });
        const descriptor = telemetry.describe(body);
        let bridgeResponse: Response | undefined;
        try {
          bridgeResponse = await handler.fetch(webRequest, { authInfo });
        } catch (error) {
          await telemetry.complete(descriptor, undefined, true);
          throw error;
        }
        await telemetry.complete(descriptor, bridgeResponse);
        await writeResponse(bridgeResponse, response);
      } catch (error) {
        if (!response.headersSent) {
          const status = (error as { status?: number }).status ?? 500;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error:
                status === 500
                  ? "Bridge request failed"
                  : (error as Error).message
            })
          );
        } else {
          response.destroy(error as Error);
        }
      } finally {
        clearTimeout(timeout);
        activeRequests.delete(abort);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Benchmark bridge did not expose a TCP address");
  }
  expectedOrigin = `http://${host}:${address.port}`;
  const unregisterTelemetry = registerBridgeTelemetry(
    expectedOrigin,
    telemetry
  );
  let closed = false;
  return {
    url: expectedOrigin,
    ...(dockerAccess
      ? { containerUrl: `http://${containerHost}:${address.port}` }
      : {}),
    token: credential.token,
    credentialId: credential.id,
    activate: (lifetimeMs) => credential.activate(lifetimeMs, now()),
    revoke: () => credential.revoke(now()),
    attestation: () => credential.attestation,
    telemetry: () => telemetry.snapshot(),
    async close() {
      if (closed) return;
      closed = true;
      unregisterTelemetry();
      credential.revoke(now());
      for (const request of activeRequests) request.abort();
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
};

export { KOED_MCP_PROTOCOL_VERSION };
