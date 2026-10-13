import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthTokens
} from "@modelcontextprotocol/client";
import {
  assertCleanRemoteMcpEnrollment,
  hasRemoteMcpLocalRuntimeScopes,
  hasRemoteMcpTeamRuntimeScopes,
  normalizeRemoteMcpBackend,
  readRemoteMcpCredential,
  readRemoteMcpPendingRevocation,
  remoteMcpCredentialPath,
  withRemoteMcpCredentialLock,
  writeRemoteMcpCredential,
  type RemoteMcpCredential,
  type RemoteMcpTokens
} from "./remote-mcp-credentials.js";
import {
  HEADLESS_REMOTE_CREDENTIAL_REF,
  checkHeadlessRemoteIntegration,
  readHeadlessRemoteIntegration,
  removeHeadlessRemoteIntegration,
  setupHeadlessRemoteIntegration,
  type HeadlessRemoteIntegrationDescriptor,
  type HeadlessRemoteHarness
} from "./headless-remote-integration.js";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import { isTeamMemoryAnswerTaskCapability } from "./upstream-registry.js";

export interface RemoteMcpClientOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  auth?: typeof auth;
  now?: () => number;
  signal?: AbortSignal;
}

const fail = (): Error =>
  new Error("Remote authentication is unavailable; explicitly log in again.");
class RemoteMcpAttentionError extends Error {}

const verifyTeamRuntimeCapability = async (
  credential: RemoteMcpCredential,
  options: RemoteMcpClientOptions
): Promise<void> => {
  if (!hasRemoteMcpTeamRuntimeScopes(credential)) return;
  const response = await pinnedFetch(credential.backendUrl, options)(
    `${credential.backendUrl}/v1/capabilities`,
    {
      headers: { authorization: `Bearer ${credential.tokens!.accessToken}` }
    }
  );
  if (!response.ok)
    throw new RemoteMcpAttentionError(
      "Team Memory Answer capability is unavailable. Refresh remote authorization with --local-runtime --team-read; Team read alone cannot authorize execution."
    );
  const text = await response.text();
  if (text.length > 128_000) throw fail();
  let body: { capabilities?: Record<string, unknown> } | null;
  try {
    body = JSON.parse(text) as {
      capabilities?: Record<string, unknown>;
    } | null;
  } catch {
    throw new RemoteMcpAttentionError(
      "Team Memory Answer capability metadata could not be verified. Refresh the upgraded backend before enabling Team execution."
    );
  }
  if (
    !isTeamMemoryAnswerTaskCapability(
      body?.capabilities?.["memory.answerTasks"]
    )
  ) {
    throw new RemoteMcpAttentionError(
      "Upgrade the backend to memory.answerTasks version 2 with Team support, then re-authorize with --local-runtime --team-read. No Team read fallback is used."
    );
  }
};
const pinnedFetch =
  (backendUrl: string, options: RemoteMcpClientOptions): typeof fetch =>
  async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    if (
      url.origin !== backendUrl ||
      url.protocol !== "https:" ||
      url.username ||
      url.password
    )
      throw fail();
    return (options.fetch ?? globalThis.fetch)(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(15_000),
        ...(init?.signal ? [init.signal] : []),
        ...(options.signal ? [options.signal] : [])
      ])
    });
  };

const assertIssuer = (issuer: string | undefined, backendUrl: string): void => {
  if (
    !issuer ||
    normalizeRemoteMcpBackend(issuer) !== backendUrl ||
    new URL(issuer).pathname !== "/"
  )
    throw fail();
};

const tokensFromSdk = (
  tokens: StoredOAuthTokens,
  requestedScope: string,
  now: number
): RemoteMcpTokens => {
  if (
    tokens.token_type.toLowerCase() !== "bearer" ||
    !tokens.expires_in ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 0
  )
    throw fail();
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: now + tokens.expires_in * 1000,
    scope: tokens.scope ?? requestedScope
  };
};

const sdkTokens = (
  credential: RemoteMcpCredential
): StoredOAuthTokens | undefined =>
  credential.tokens
    ? {
        access_token: credential.tokens.accessToken,
        refresh_token: credential.tokens.refreshToken,
        token_type: "Bearer",
        scope: credential.tokens.scope,
        issuer: credential.issuerUrl
      }
    : undefined;

const verifyOwner = async (
  backendUrl: string,
  tokens: RemoteMcpTokens,
  options: RemoteMcpClientOptions
): Promise<string> => {
  const response = await pinnedFetch(backendUrl, options)(
    `${backendUrl}/v1/access/check`,
    {
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    }
  );
  if (!response.ok) throw fail();
  const body = await response.text();
  if (body.length > 128_000) throw fail();
  const value = JSON.parse(body) as { ok?: unknown; user?: { id?: unknown } };
  if (
    value.ok !== true ||
    typeof value.user?.id !== "string" ||
    !value.user.id ||
    value.user.id.length > 256
  )
    throw fail();
  return value.user.id;
};

const browserOpen = (url: URL): void => {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url.href], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
};

export const loginRemoteMcp = async (
  options: RemoteMcpClientOptions & {
    backendUrl: string;
    consent?: boolean;
    localRuntime?: boolean;
    teamRead?: boolean;
    openAuthorization?: (url: URL) => void | Promise<void>;
    timeoutMs?: number;
  }
): Promise<{ ok: true; backendUrl: string; userId: string; scope: string }> => {
  if (options.consent !== true || options.signal?.aborted)
    throw new Error("Explicit remote login consent is required.");
  const environment = options.environment ?? process.env;
  const backendUrl = normalizeRemoteMcpBackend(options.backendUrl);
  assertCleanRemoteMcpEnrollment(environment);
  return withRemoteMcpCredentialLock(environment, async () => {
    const previous = readRemoteMcpCredential(environment);
    if (readRemoteMcpPendingRevocation(environment))
      throw new Error(
        "Remote revocation is pending; retry logout before login."
      );
    if (previous && previous.backendUrl !== backendUrl)
      throw new Error("Use a new dedicated KOED_HOME for another backend.");
    const scope = [
      "koed:memory:read",
      ...(options.teamRead ? ["koed:team:read"] : []),
      ...(options.localRuntime ? ["koed:capture", "koed:local-execution"] : [])
    ].join(" ");
    const state = randomBytes(32).toString("base64url");
    let verifier = "";
    let discovery: OAuthDiscoveryState | undefined;
    let clientId: string | undefined;
    let tokens: RemoteMcpTokens | undefined;
    let resolveCallback!: (value: { code: string; iss?: string }) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<{ code: string; iss?: string }>(
      (resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      }
    );
    // Attach rejection handling before discovery can fail or the callback can time out.
    void callback.catch(() => undefined);
    const server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("referrer-policy", "no-referrer");
      const address = server.address();
      const host =
        address && typeof address !== "string"
          ? `127.0.0.1:${address.port}`
          : "";
      let url: URL;
      try {
        if (!request.url?.startsWith("/")) throw fail();
        url = new URL(request.url, `http://${host}`);
      } catch {
        response.writeHead(400).end("Authorization callback rejected.");
        return;
      }
      const returnedState = url.searchParams.get("state") ?? "";
      const stateBytes = Buffer.from(state);
      const returnedBytes = Buffer.from(returnedState);
      const validState =
        returnedBytes.length === stateBytes.length &&
        timingSafeEqual(returnedBytes, stateBytes);
      if (
        request.method !== "GET" ||
        request.headers.host !== host ||
        url.origin !== `http://${host}` ||
        url.pathname !== "/callback" ||
        !validState ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("iss").length > 1
      ) {
        response.writeHead(400).end("Authorization callback rejected.");
        return;
      }
      const code = url.searchParams.get("code");
      const iss = url.searchParams.get("iss") ?? undefined;
      if (!code || code.length > 8192 || url.searchParams.has("error")) {
        response.writeHead(400).end("Authorization was not completed.");
        rejectCallback(fail());
        return;
      }
      try {
        if (iss) assertIssuer(iss, backendUrl);
        resolveCallback({ code, iss });
        response.end("Authorization received. Return to Koed.");
      } catch {
        response.writeHead(400).end("Authorization issuer rejected.");
        rejectCallback(fail());
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw fail();
    const redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    const timer = setTimeout(
      () => rejectCallback(new Error("Remote login timed out.")),
      Math.min(options.timeoutMs ?? 300_000, 300_000)
    );
    const abort = () => rejectCallback(new Error("Remote login cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    const provider: OAuthClientProvider = {
      redirectUrl,
      clientMetadata: {
        client_name: "Koed Local AI Runtime",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      },
      state: () => state,
      clientInformation: (context) => {
        if (context) assertIssuer(context.issuer, backendUrl);
        return clientId
          ? { client_id: clientId, issuer: backendUrl }
          : undefined;
      },
      saveClientInformation: (information, context) => {
        assertIssuer(context?.issuer ?? information.issuer, backendUrl);
        if (information.client_secret) throw fail();
        clientId = information.client_id;
      },
      tokens: () => undefined,
      saveTokens: (value, context) => {
        assertIssuer(context?.issuer ?? value.issuer, backendUrl);
        tokens = tokensFromSdk(value, scope, (options.now ?? Date.now)());
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      saveAuthorizationServerUrl: (issuer) => assertIssuer(issuer, backendUrl),
      saveDiscoveryState: (value) => {
        assertIssuer(value.authorizationServerUrl, backendUrl);
        if (value.authorizationServerMetadata)
          assertIssuer(value.authorizationServerMetadata.issuer, backendUrl);
        if (value.resourceMetadata?.resource !== `${backendUrl}/mcp`)
          throw fail();
        discovery = value;
      },
      discoveryState: () => discovery,
      validateResourceURL: (_server, resource) => {
        if (resource !== `${backendUrl}/mcp`) throw fail();
        return Promise.resolve(new URL(`${backendUrl}/mcp`));
      },
      redirectToAuthorization: (url) => {
        if (
          url.origin !== backendUrl ||
          url.searchParams.get("state") !== state ||
          url.searchParams.get("code_challenge_method") !== "S256"
        )
          throw fail();
        return Promise.resolve(
          options.openAuthorization
            ? options.openAuthorization(url)
            : browserOpen(url)
        );
      }
    };
    try {
      const authFn = options.auth ?? auth;
      const authOptions = {
        serverUrl: `${backendUrl}/mcp`,
        scope,
        fetchFn: pinnedFetch(backendUrl, options)
      };
      if ((await authFn(provider, authOptions)) !== "REDIRECT") throw fail();
      const received = await callback;
      if (
        (await authFn(provider, {
          ...authOptions,
          authorizationCode: received.code,
          iss: received.iss
        })) !== "AUTHORIZED" ||
        !tokens ||
        !clientId
      )
        throw fail();
      const userId = await verifyOwner(backendUrl, tokens, options);
      if (previous && userId !== previous.userId)
        throw new Error("Use a new dedicated KOED_HOME for another User.");
      writeRemoteMcpCredential(environment, {
        version: 1,
        backendUrl,
        resourceUrl: `${backendUrl}/mcp`,
        issuerUrl: backendUrl,
        userId,
        clientId,
        tokens
      });
      return { ok: true, backendUrl, userId, scope: tokens.scope };
    } catch {
      throw fail();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
};

const renewals = new Map<string, Promise<string>>();

export const remoteMcpAuthorization = (
  options: RemoteMcpClientOptions = {}
): Promise<string> => {
  const environment = options.environment ?? process.env;
  if (options.signal?.aborted) return Promise.reject(fail());
  try {
    if (!readRemoteMcpCredential(environment)?.tokens)
      return Promise.reject(fail());
  } catch {
    return Promise.reject(fail());
  }
  const path = remoteMcpCredentialPath(environment);
  const pending = renewals.get(path);
  if (pending) return pending;
  const renewal = withRemoteMcpCredentialLock(environment, async () => {
    const record = readRemoteMcpCredential(environment);
    if (!record?.tokens) throw fail();
    if (record.tokens.expiresAt > (options.now ?? Date.now)() + 60_000)
      return `Bearer ${record.tokens.accessToken}`;
    if (!record.tokens.refreshToken) throw fail();
    let updated: RemoteMcpTokens | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1/callback",
      clientMetadata: { redirect_uris: [], token_endpoint_auth_method: "none" },
      clientInformation: (context) => {
        if (context) assertIssuer(context.issuer, record.backendUrl);
        return { client_id: record.clientId, issuer: record.issuerUrl };
      },
      tokens: () => sdkTokens(record),
      saveTokens: (value, context) => {
        assertIssuer(context?.issuer ?? value.issuer, record.backendUrl);
        updated = tokensFromSdk(
          value,
          record.tokens!.scope,
          (options.now ?? Date.now)()
        );
      },
      saveAuthorizationServerUrl: (issuer) =>
        assertIssuer(issuer, record.backendUrl),
      validateResourceURL: (_server, resource) => {
        if (resource !== record.resourceUrl) throw fail();
        return Promise.resolve(new URL(record.resourceUrl));
      },
      redirectToAuthorization: () => {
        throw fail();
      },
      saveCodeVerifier: () => {
        throw fail();
      },
      codeVerifier: () => {
        throw fail();
      }
    };
    try {
      if (
        (await (options.auth ?? auth)(provider, {
          serverUrl: record.resourceUrl,
          scope: record.tokens.scope,
          fetchFn: pinnedFetch(record.backendUrl, options)
        })) !== "AUTHORIZED" ||
        !updated
      )
        throw fail();
      if (
        (await verifyOwner(record.backendUrl, updated, options)) !==
        record.userId
      )
        throw fail();
      writeRemoteMcpCredential(environment, { ...record, tokens: updated });
      return `Bearer ${updated.accessToken}`;
    } catch {
      throw fail();
    }
  }).finally(() => renewals.delete(path));
  renewals.set(path, renewal);
  return renewal;
};

export const logoutRemoteMcp = async (
  options: RemoteMcpClientOptions & { consent?: boolean } = {}
): Promise<{ ok: true; remoteRevoked: boolean }> => {
  if (options.consent !== true)
    throw new Error("Explicit logout consent is required.");
  const environment = options.environment ?? process.env;
  return withRemoteMcpCredentialLock(environment, async () => {
    const record = readRemoteMcpCredential(environment);
    if (!record) return { ok: true, remoteRevoked: true };
    const pendingRevocation =
      readRemoteMcpPendingRevocation(environment) ??
      (record.tokens
        ? {
            token: record.tokens.refreshToken ?? record.tokens.accessToken,
            tokenTypeHint: record.tokens.refreshToken
              ? ("refresh_token" as const)
              : ("access_token" as const)
          }
        : undefined);
    // Disable local use before attempting the remote request, retaining only retry material.
    writeRemoteMcpCredential(environment, {
      ...record,
      tokens: undefined,
      pendingRevocation
    });
    let remoteRevoked = !pendingRevocation;
    if (pendingRevocation) {
      try {
        const body = new URLSearchParams({
          client_id: record.clientId,
          token: pendingRevocation.token,
          token_type_hint: pendingRevocation.tokenTypeHint
        });
        const response = await pinnedFetch(record.backendUrl, options)(
          `${record.backendUrl}/revoke`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body
          }
        );
        remoteRevoked = response.ok;
      } catch {
        /* Revocation-only custody remains available for an explicit logout retry. */
      }
    }
    if (remoteRevoked)
      writeRemoteMcpCredential(environment, { ...record, tokens: undefined });
    return { ok: true, remoteRevoked };
  });
};

export const startRemoteMcpLocalRuntime = async (
  options: RemoteMcpClientOptions = {}
): Promise<{ close(): Promise<void> }> => {
  const environment = options.environment ?? process.env;
  const descriptor = readHeadlessRemoteIntegration(environment);
  const credential = readRemoteMcpCredential(environment);
  if (
    !descriptor ||
    !credential ||
    descriptor.backendUrl !== credential.backendUrl ||
    !hasRemoteMcpLocalRuntimeScopes(credential)
  )
    throw fail();
  await remoteMcpAuthorization(options);
  const refreshed = readRemoteMcpCredential(environment);
  if (
    !refreshed?.tokens ||
    (await verifyOwner(refreshed.backendUrl, refreshed.tokens, options)) !==
      refreshed.userId
  )
    throw fail();
  await verifyTeamRuntimeCapability(refreshed, options);
  const runtime = resolveKoedAppRuntime(
    resolveKoedServerPaths(environment),
    environment
  );
  const entry = resolve(dirname(runtime.mcpCli), "runtime-contracts.js");
  if (
    ![runtime.mcpCli, runtime.captureHook, runtime.localAiRuntime, entry].every(
      existsSync
    )
  )
    throw new Error(
      "Build or install the Koed Local AI Runtime integration artifacts first."
    );
  const module: unknown = await import(pathToFileURL(entry).href);
  const contracts = module as {
    startHeadlessRemoteLocalAiRuntime: (options: {
      descriptor: HeadlessRemoteIntegrationDescriptor;
      environment: NodeJS.ProcessEnv;
      authorizationProvider: () => Promise<string>;
      allowTeamRuntime: boolean;
    }) => Promise<{ close(): Promise<void> }>;
  };
  if (typeof contracts.startHeadlessRemoteLocalAiRuntime !== "function")
    throw new Error(
      "The installed Local AI Runtime lacks remote integration support."
    );
  return contracts.startHeadlessRemoteLocalAiRuntime({
    descriptor,
    environment,
    allowTeamRuntime: hasRemoteMcpTeamRuntimeScopes(refreshed),
    authorizationProvider: () => remoteMcpAuthorization(options)
  });
};

export const runRemoteMcpCommand = async (
  args: string[],
  options: {
    environment?: NodeJS.ProcessEnv;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  }
): Promise<number> => {
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const environment = {
    ...(options.environment ?? process.env),
    ...(flag("--koed-home") ? { KOED_HOME: flag("--koed-home") } : {})
  };
  const consent = args.includes("--consent");
  const command = args[0];
  let output: unknown;
  let ok = true;
  try {
    if (["setup", "remove"].includes(command ?? "") && !consent) {
      options.stdout.write(
        `${JSON.stringify({ ok: false, state: "consent_required" })}\n`
      );
      return 1;
    }
    if (command === "login") {
      const backendUrl = flag("--backend");
      if (!backendUrl)
        throw new Error("remote login requires --backend HTTPS_URL.");
      output = await loginRemoteMcp({
        environment,
        backendUrl,
        consent,
        localRuntime: args.includes("--local-runtime"),
        teamRead: args.includes("--team-read"),
        openAuthorization: (url) => {
          options.stderr.write(`Authorize Koed in your browser: ${url.href}\n`);
          browserOpen(url);
        }
      });
    } else if (command === "logout") {
      output = await logoutRemoteMcp({ environment, consent });
    } else if (command === "start") {
      const runtime = await startRemoteMcpLocalRuntime({ environment });
      output = { ok: true, state: "running" };
      options.stdout.write(`${JSON.stringify(output)}\n`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          void runtime.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    } else if (["setup", "check", "remove"].includes(command ?? "")) {
      const harness = args[1] as HeadlessRemoteHarness;
      if (!["codex", "claude", "pi"].includes(harness))
        throw new Error("Select codex, claude, or pi.");
      if (command !== "remove") await remoteMcpAuthorization({ environment });
      const credential = readRemoteMcpCredential(environment);
      if (
        command !== "remove" &&
        credential?.tokens &&
        (await verifyOwner(credential.backendUrl, credential.tokens, {
          environment
        })) !== credential.userId
      )
        throw fail();
      const credentialAvailable = () =>
        Boolean(
          credential?.tokens && hasRemoteMcpLocalRuntimeScopes(credential)
        );
      if (command !== "remove" && credential)
        await verifyTeamRuntimeCapability(credential, { environment });
      const common = { environment, harness, consent, credentialAvailable };
      output =
        command === "setup"
          ? setupHeadlessRemoteIntegration({
              ...common,
              backendUrl: credential?.backendUrl ?? "",
              credentialRef: HEADLESS_REMOTE_CREDENTIAL_REF
            })
          : command === "check"
            ? checkHeadlessRemoteIntegration(common)
            : removeHeadlessRemoteIntegration(common);
      ok = (output as { ok: boolean }).ok;
    } else throw new Error("Unknown remote command.");
    options.stdout.write(
      `${JSON.stringify(output, null, args.includes("--json") ? 2 : undefined)}\n`
    );
    return ok ? 0 : 1;
  } catch (cause) {
    const error =
      cause instanceof RemoteMcpAttentionError
        ? cause.message
        : "Remote integration needs attention. Check explicit consent, dedicated KOED_HOME, authentication scopes, and local integration artifacts.";
    if (args.includes("--json")) {
      options.stdout.write(
        `${JSON.stringify({ ok: false, state: "needs_attention", error })}\n`
      );
    } else {
      options.stderr.write(`${error}\n`);
    }
    return 1;
  }
};
