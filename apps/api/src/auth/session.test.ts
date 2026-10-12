import type { FastifyRequest } from "fastify";
import type { MemorySourceRepository } from "@koed/db";
import { expect, it, vi } from "vitest";
import { createAuthHelpers } from "./session.js";
import type { RemoteMcpDelegatedPrincipal } from "./remote-mcp-oauth.js";

const delegatedFixture = (scopes: string[]) => {
  const user = { id: "owner", email: "owner@example.test", displayName: null };
  const getUser = vi.fn().mockResolvedValue(user);
  const getApiTokenUser = vi.fn().mockResolvedValue(null);
  const resolveDelegatedPrincipal = vi.fn().mockResolvedValue({
    userId: user.id,
    grantId: "grant",
    clientId: "client",
    resource: "https://memory.example.test/mcp",
    scopes,
    expiresAt: Date.now() + 60_000
  } satisfies RemoteMcpDelegatedPrincipal);
  const auth = createAuthHelpers(
    () => ({ getUser, getApiTokenUser }) as unknown as MemorySourceRepository,
    {
      hashSecret: (value) => value,
      cookieSecure: false,
      resolveDelegatedPrincipal
    }
  );
  const request = (method: string, url: string) =>
    ({
      method,
      url,
      headers: { authorization: "Bearer delegated" },
      cookies: {}
    }) as FastifyRequest;
  return {
    auth,
    user,
    request,
    getUser,
    getApiTokenUser,
    resolveDelegatedPrincipal
  };
};

it("allows delegated Personal read while requiring separate capture and execution consent", async () => {
  const fixture = delegatedFixture(["koed:memory:read"]);
  await expect(
    fixture.auth.authenticate(fixture.request("POST", "/v1/memory/search"))
  ).resolves.toEqual(fixture.user);
  await expect(
    fixture.auth.authenticate(
      fixture.request("POST", "/v1/memory/conversation-items")
    )
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    fixture.auth.authenticate(
      fixture.request("POST", "/v1/memory/answer-tasks/claim")
    )
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(fixture.getUser).toHaveBeenCalledTimes(1);
});

it("requires explicit Team read consent on shared memory endpoints", async () => {
  const fixture = delegatedFixture(["koed:memory:read"]);
  await expect(
    fixture.auth.authenticateSessionOrDeviceCredential(
      fixture.request("POST", "/v1/memory/answer"),
      "team_workspace_read"
    )
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(fixture.getUser).not.toHaveBeenCalled();
  fixture.resolveDelegatedPrincipal.mockResolvedValueOnce({
    userId: "owner",
    grantId: "grant",
    clientId: "client",
    resource: "https://memory.example.test/mcp",
    scopes: ["koed:memory:read", "koed:team:read"],
    expiresAt: Date.now() + 60_000
  });
  await expect(
    fixture.auth.authenticateSessionOrDeviceCredential(
      fixture.request("POST", "/v1/memory/answer"),
      "team_workspace_read"
    )
  ).resolves.toEqual(fixture.user);
});

it("denies delegated administration and stops accepting revoked or deleted principals", async () => {
  const fixture = delegatedFixture(["koed:memory:read", "koed:team:read"]);
  await expect(
    fixture.auth.authenticateSessionOrDeviceCredential(
      fixture.request("POST", "/v1/team-workspaces/workspace/members"),
      "admin"
    )
  ).rejects.toMatchObject({ statusCode: 403 });
  fixture.getUser.mockResolvedValueOnce(null);
  await expect(
    fixture.auth.authenticate(fixture.request("POST", "/v1/memory/search"))
  ).rejects.toMatchObject({ statusCode: 401 });
  fixture.resolveDelegatedPrincipal.mockRejectedValueOnce(new Error("revoked"));
  await expect(
    fixture.auth.authenticate(fixture.request("POST", "/v1/memory/search"))
  ).rejects.toMatchObject({ statusCode: 401 });
});

it("preserves Personal API Token access without granting Team authority", async () => {
  const fixture = delegatedFixture(["koed:memory:read"]);
  fixture.getApiTokenUser.mockResolvedValueOnce(fixture.user);
  await expect(
    fixture.auth.authenticate(fixture.request("POST", "/v1/memory/search"))
  ).resolves.toEqual(fixture.user);
  expect(fixture.resolveDelegatedPrincipal).not.toHaveBeenCalled();
  fixture.resolveDelegatedPrincipal.mockRejectedValueOnce(
    new Error("not OAuth")
  );
  await expect(
    fixture.auth.authenticateSessionOrDeviceCredential(
      fixture.request("POST", "/v1/memory/answer"),
      "team_workspace_read"
    )
  ).rejects.toMatchObject({ statusCode: 403 });
});

it("does not switch a revoked delegated bearer to the browser session identity", async () => {
  const fixture = delegatedFixture(["koed:memory:read"]);
  fixture.resolveDelegatedPrincipal.mockRejectedValueOnce(new Error("revoked"));
  const request = fixture.request("POST", "/v1/memory/search");
  request.headers.authorization = "Bearer koed_mcp_access_revoked";
  request.cookies.cm_session = "otherwise-valid-browser-session";
  await expect(fixture.auth.authenticate(request)).rejects.toMatchObject({
    statusCode: 401
  });
  expect(fixture.getUser).not.toHaveBeenCalled();
});

it("refreshes long-lived device authority on the same request after scope removal and revocation", async () => {
  const user = {
    id: "fixture-owner",
    email: "fixture@example.test",
    displayName: null
  };
  const getDeviceCredentialUser = vi
    .fn()
    .mockResolvedValueOnce({
      user,
      credential: { operationFamilies: ["managed_terminal"] }
    })
    .mockResolvedValueOnce({
      user,
      credential: { operationFamilies: ["managed_file_read"] }
    })
    .mockResolvedValueOnce(null);
  const auth = createAuthHelpers(
    () => ({ getDeviceCredentialUser }) as unknown as MemorySourceRepository,
    { hashSecret: (value) => `hashed:${value}`, cookieSecure: false }
  );
  const request = {
    headers: { authorization: "Koed-Device fixture:secret" },
    cookies: {}
  } as FastifyRequest;
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal")
  ).resolves.toEqual(user);
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal", {
      freshDeviceCredential: true
    })
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    auth.authenticateSessionOrDeviceCredential(request, "managed_terminal", {
      freshDeviceCredential: true
    })
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(getDeviceCredentialUser).toHaveBeenCalledTimes(3);
});
