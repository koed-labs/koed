import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loginRemoteMcp,
  logoutRemoteMcp,
  remoteMcpAuthorization,
  startRemoteMcpLocalRuntime,
  runRemoteMcpCommand
} from "./remote-mcp-client.js";
import {
  readRemoteMcpCredential,
  remoteMcpCredentialPath,
  writeRemoteMcpCredential
} from "./remote-mcp-credentials.js";
import {
  HEADLESS_REMOTE_CREDENTIAL_REF,
  writeHeadlessRemoteIntegration
} from "./headless-remote-integration.js";

const roots: string[] = [];
const backend = "https://koed.example.test";
const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-remote-client-"));
  roots.push(root);
  const environment = { KOED_HOME: resolve(root, "koed") };
  let authorization: URL | undefined;
  let userId = "user-1";
  let refreshes = 0;
  let denied = false;
  let taskCapability: unknown = {
    availability: "available",
    version: 2,
    supportedScopes: ["personal", "team"]
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe("error");
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: `${backend}/mcp`,
        authorization_servers: [backend],
        scopes_supported: [
          "koed:memory:read",
          "koed:capture",
          "koed:local-execution",
          "koed:team:read"
        ]
      });
    if (url.pathname.includes("oauth-authorization-server"))
      return Response.json({
        issuer: backend,
        authorization_endpoint: `${backend}/authorize`,
        token_endpoint: `${backend}/token`,
        registration_endpoint: `${backend}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"]
      });
    if (url.pathname === "/register") {
      const metadata = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      expect(metadata.token_endpoint_auth_method).toBe("none");
      return Response.json(
        { ...metadata, client_id: "public-client" },
        { status: 201 }
      );
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("resource")).toBe(`${backend}/mcp`);
      if (params.get("grant_type") === "authorization_code") {
        expect(params.get("code")).toBe("reviewed-code");
        expect(
          createHash("sha256")
            .update(params.get("code_verifier")!)
            .digest("base64url")
        ).toBe(authorization?.searchParams.get("code_challenge"));
        expect(params.get("redirect_uri")).toBe(
          authorization?.searchParams.get("redirect_uri")
        );
      } else {
        refreshes++;
        if (denied)
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "secret-must-not-be-logged"
            },
            { status: 400 }
          );
      }
      return Response.json({
        access_token: `access-${refreshes}`,
        refresh_token: `refresh-${refreshes}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: authorization?.searchParams.get("scope") ?? "koed:memory:read"
      });
    }
    if (url.pathname === "/v1/access/check")
      return Response.json({ ok: true, user: { id: userId } });
    if (url.pathname === "/revoke") return new Response(null, { status: 200 });
    if (url.pathname === "/v1/capabilities")
      return Response.json({
        capabilities: { "memory.answerTasks": taskCapability }
      });
    throw new Error(`Unexpected request path: ${url.pathname}`);
  });
  const openAuthorization = async (url: URL) => {
    authorization = url;
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "reviewed-code");
    callback.searchParams.set("state", "wrong-state");
    expect((await globalThis.fetch(callback)).status).toBe(400);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("iss", backend);
    expect((await globalThis.fetch(callback)).status).toBe(200);
  };
  return {
    root,
    environment,
    fetch,
    openAuthorization,
    setUser: (value: string) => {
      userId = value;
    },
    denyRefresh: () => {
      denied = true;
    },
    refreshes: () => refreshes,
    setTaskCapability: (value: unknown) => {
      taskCapability = value;
    }
  };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("remote MCP OAuth client", () => {
  it.each([
    {
      availability: "available",
      version: 1,
      supportedScopes: ["personal", "team"]
    },
    { availability: "available", version: 2, supportedScopes: ["personal"] },
    {
      availability: "partial",
      version: 2,
      supportedScopes: ["personal", "team"]
    }
  ])(
    "requires the available Team task contract before starting an OAuth Team worker: %j",
    async (capability) => {
      const context = fixture();
      await loginRemoteMcp({
        ...context,
        backendUrl: backend,
        consent: true,
        localRuntime: true,
        teamRead: true
      });
      writeHeadlessRemoteIntegration(context.environment, {
        version: 1,
        backendUrl: backend,
        credentialRef: HEADLESS_REMOTE_CREDENTIAL_REF,
        harnesses: ["codex"],
        futureCaptureOnly: true
      });
      context.setTaskCapability(capability);
      await expect(startRemoteMcpLocalRuntime(context)).rejects.toThrow(
        "No Team read fallback is used"
      );
      expect(
        context.fetch.mock.calls.some(
          ([input]) => new URL(String(input)).pathname === "/v1/capabilities"
        )
      ).toBe(true);
    }
  );
  it("uses SDK public PKCE login, pins resource and issuer, and validates loopback state", async () => {
    const context = fixture();
    const loggedIn = await loginRemoteMcp({
      ...context,
      backendUrl: backend,
      consent: true,
      localRuntime: true
    });
    expect(loggedIn).toEqual({
      ok: true,
      backendUrl: backend,
      userId: "user-1",
      scope: "koed:memory:read koed:capture koed:local-execution"
    });
    const record = readRemoteMcpCredential(context.environment)!;
    expect(record.resourceUrl).toBe(`${backend}/mcp`);
    expect(record.issuerUrl).toBe(backend);
    expect(record.tokens?.accessToken).toBe("access-0");
    expect(await remoteMcpAuthorization(context)).toBe("Bearer access-0");
  });

  it("defaults to read-only authorization and requires explicit login consent before writes", async () => {
    const context = fixture();
    await expect(
      loginRemoteMcp({ ...context, backendUrl: backend })
    ).rejects.toThrow("consent");
    expect(context.fetch).not.toHaveBeenCalled();
    expect(existsSync(context.environment.KOED_HOME)).toBe(false);
    const result = await loginRemoteMcp({
      ...context,
      backendUrl: backend,
      consent: true
    });
    expect(result.scope).toBe("koed:memory:read");
  });

  it("rejects cross-origin discovery before sending registration or token material", async () => {
    const context = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        resource: `${backend}/mcp`,
        authorization_servers: ["https://untrusted.example.test"]
      })
    );
    await expect(
      loginRemoteMcp({ ...context, fetch, backendUrl: backend, consent: true })
    ).rejects.toThrow("unavailable");
    expect(
      fetch.mock.calls.every(
        ([input]) => new URL(String(input)).origin === backend
      )
    ).toBe(true);
    expect(readRemoteMcpCredential(context.environment)).toBeNull();
  });

  it("bounds login waiting and cancels without persisting credentials", async () => {
    const context = fixture();
    await expect(
      loginRemoteMcp({
        ...context,
        backendUrl: backend,
        consent: true,
        timeoutMs: 10,
        openAuthorization: () => undefined
      })
    ).rejects.toThrow("unavailable");
    expect(readRemoteMcpCredential(context.environment)).toBeNull();
    const controller = new AbortController();
    await expect(
      loginRemoteMcp({
        ...context,
        backendUrl: backend,
        consent: true,
        signal: controller.signal,
        openAuthorization: () => controller.abort()
      })
    ).rejects.toThrow("unavailable");
    expect(readRemoteMcpCredential(context.environment)).toBeNull();
  });

  it("renews singleflight without browser interaction and revalidates owner binding", async () => {
    const context = fixture();
    await loginRemoteMcp({ ...context, backendUrl: backend, consent: true });
    const credential = readRemoteMcpCredential(context.environment)!;
    writeRemoteMcpCredential(context.environment, {
      ...credential,
      tokens: { ...credential.tokens!, expiresAt: 1 }
    });
    expect(
      await Promise.all([
        remoteMcpAuthorization(context),
        remoteMcpAuthorization(context),
        remoteMcpAuthorization(context)
      ])
    ).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-1"]);
    expect(context.refreshes()).toBe(1);
    context.setUser("different-user");
    const refreshed = readRemoteMcpCredential(context.environment)!;
    writeRemoteMcpCredential(context.environment, {
      ...refreshed,
      tokens: { ...refreshed.tokens!, expiresAt: 1 }
    });
    await expect(remoteMcpAuthorization(context)).rejects.toThrow(
      "unavailable"
    );
    expect(readRemoteMcpCredential(context.environment)?.userId).toBe("user-1");
    expect(
      readRemoteMcpCredential(context.environment)?.tokens?.accessToken
    ).toBe("access-1");
  });

  it("fails closed on revoked refresh with no secret error details or browser popup", async () => {
    const context = fixture();
    await loginRemoteMcp({ ...context, backendUrl: backend, consent: true });
    const credential = readRemoteMcpCredential(context.environment)!;
    writeRemoteMcpCredential(context.environment, {
      ...credential,
      tokens: { ...credential.tokens!, expiresAt: 1 }
    });
    context.denyRefresh();
    await expect(remoteMcpAuthorization(context)).rejects.toThrow(
      "Remote authentication is unavailable"
    );
  });

  it("logs out by clearing tokens while retaining owner/backend binding and unrelated files", async () => {
    const context = fixture();
    await loginRemoteMcp({ ...context, backendUrl: backend, consent: true });
    await expect(
      logoutRemoteMcp({ ...context, consent: false })
    ).rejects.toThrow("consent");
    expect(
      (await logoutRemoteMcp({ ...context, consent: true })).remoteRevoked
    ).toBe(true);
    expect(readRemoteMcpCredential(context.environment)).toMatchObject({
      userId: "user-1",
      backendUrl: backend
    });
    expect(
      readRemoteMcpCredential(context.environment)?.tokens
    ).toBeUndefined();
    expect(
      readFileSync(remoteMcpCredentialPath(context.environment), "utf8")
    ).not.toContain("access-0");
    await expect(remoteMcpAuthorization(context)).rejects.toThrow(
      "unavailable"
    );
    context.setUser("different-user");
    await expect(
      loginRemoteMcp({ ...context, backendUrl: backend, consent: true })
    ).rejects.toThrow("unavailable");
    expect(
      readRemoteMcpCredential(context.environment)?.tokens
    ).toBeUndefined();
  });

  it("keeps CLI setup and remove side-effect free without explicit consent", async () => {
    const context = fixture();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    expect(
      await runRemoteMcpCommand(["setup", "codex"], {
        ...context,
        stdout,
        stderr
      })
    ).toBe(1);
    expect(
      await runRemoteMcpCommand(["remove", "codex"], {
        ...context,
        stdout,
        stderr
      })
    ).toBe(1);
    expect(existsSync(context.environment.KOED_HOME)).toBe(false);
    expect(stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("consent_required")
    );
  });
});
