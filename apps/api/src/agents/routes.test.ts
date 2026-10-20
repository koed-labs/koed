import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { AgentInstanceUnavailableError, AgentNotFoundError } from "@koed/db";
import type { Agent } from "@koed/shared";
import {
  storeDesktopLocalCredential,
  deleteDesktopLocalCredential
} from "@koed/shared";
import { routeIdentityFor } from "../server/route-identity.js";
import { registerAgentRoutes } from "./routes.js";

const owner = randomUUID();
const scratch = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scratch"
);
mkdirSync(scratch, { recursive: true });
const agent: Agent = {
  id: randomUUID(),
  ownerUserId: owner,
  name: "Chief of Staff",
  role: null,
  look: {},
  aiClientInstanceId: "codex.default",
  defaultPermissionMode: "supervised",
  defaultModel: null,
  isChiefOfStaff: true,
  createdAt: new Date().toISOString()
};

const fixture = (profile = "local_personal", koedHome?: string) => {
  const app = Fastify();
  const repository = {
    bootstrapContext: vi.fn(async () => ({
      ownerUserId: owner,
      savedConversations: {
        provider: "codex",
        aiClientInstanceId: "codex.default"
      },
      enabledInstances: [{ instanceId: "codex.default", driverId: "codex" }]
    })),
    list: vi.fn(async () => [agent]),
    ensureChief: vi.fn(async () => agent),
    create: vi.fn(async () => ({ ...agent, isChiefOfStaff: false })),
    patch: vi.fn(async () => agent)
  };
  const auth = vi.fn(
    async (
      request: { headers: { authorization?: string } },
      family: string
    ) => {
      if (request.headers.authorization?.startsWith("Bearer "))
        throw Object.assign(
          new Error("API Tokens cannot authorize Agent operations"),
          { statusCode: 403 }
        );
      if (
        ![
          "personal_collaboration_read",
          "personal_collaboration_write"
        ].includes(family)
      )
        throw new Error("Invalid family");
      return { id: owner };
    }
  );
  registerAgentRoutes(app, {
    repository: repository as never,
    auth: { authenticateSessionOrDeviceCredential: auth } as never,
    deploymentProfile: profile,
    koedHome,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  return { app, repository, auth };
};

describe("Agent API", () => {
  it("uses read and write collaboration authority and authenticated owner", async () => {
    const { app, repository, auth } = fixture();
    try {
      const list = await app.inject({ method: "GET", url: "/v1/agents" });
      expect(list.statusCode).toBe(200);
      expect(repository.list).toHaveBeenCalledWith(owner);
      const bootstrap = await app.inject({
        method: "GET",
        url: "/v1/agents/bootstrap-context"
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().ownerUserId).toBe(owner);
      expect(repository.bootstrapContext).toHaveBeenCalledWith(owner);
      expect(auth).toHaveBeenCalledWith(
        expect.anything(),
        "personal_collaboration_read",
        expect.anything()
      );
      const chief = await app.inject({
        method: "POST",
        url: "/v1/agents/chief:ensure",
        payload: { aiClientInstanceId: "codex.default" }
      });
      expect(chief.statusCode).toBe(200);
      expect(repository.ensureChief).toHaveBeenCalledWith(
        owner,
        "codex.default"
      );
      expect(auth).toHaveBeenCalledWith(
        expect.anything(),
        "personal_collaboration_write",
        expect.anything()
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/agents/chief:ensure",
            payload: {
              aiClientInstanceId: "codex.default",
              ownerUserId: randomUUID()
            }
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("rejects API tokens and nonlocal profiles without mutating", async () => {
    const { app, repository } = fixture();
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/agents/chief:ensure",
        headers: { authorization: "Bearer token" },
        payload: { aiClientInstanceId: "codex.default" }
      });
      expect(denied.statusCode).toBe(403);
      expect(repository.ensureChief).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    const remote = fixture("team_self_hosted");
    try {
      expect(
        (await remote.app.inject({ method: "GET", url: "/v1/agents" }))
          .statusCode
      ).toBe(403);
      expect(
        (
          await remote.app.inject({
            method: "GET",
            url: "/v1/agents/bootstrap-context"
          })
        ).statusCode
      ).toBe(403);
    } finally {
      await remote.app.close();
    }
  });
  it("reports missing or disabled owner instance as conflict", async () => {
    const { app, repository } = fixture();
    repository.ensureChief.mockRejectedValueOnce(
      new AgentInstanceUnavailableError("Missing instance")
    );
    try {
      const result = await app.inject({
        method: "POST",
        url: "/v1/agents/chief:ensure",
        payload: { aiClientInstanceId: "codex.missing" }
      });
      expect(result.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("keeps Chief flags server-owned and hides foreign Agent updates", async () => {
    const { app, repository } = fixture();
    try {
      const body = {
        name: "Helper",
        role: null,
        look: {},
        aiClientInstanceId: "codex.default",
        defaultPermissionMode: "supervised",
        defaultModel: null
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/agents",
            payload: {
              ...body,
              isChiefOfStaff: true
            }
          })
        ).statusCode
      ).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: "POST", url: "/v1/agents", payload: body }))
          .statusCode
      ).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(owner, body);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/agents/${agent.id}`,
            payload: { isChiefOfStaff: false }
          })
        ).statusCode
      ).toBe(400);
      repository.patch.mockRejectedValueOnce(
        new AgentNotFoundError("Agent not found")
      );
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/agents/${randomUUID()}`,
            payload: { name: "Other" }
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
  it("enforces real local credential custody, operation family, loopback and revocation", async () => {
    const home = mkdtempSync(join(scratch, "koed-agents-auth-"));
    const readOnly = storeDesktopLocalCredential(home, {
      ownerUserId: owner,
      operationFamilies: ["personal_collaboration_read"]
    });
    const { app, repository, auth } = fixture("local_personal", home);
    const send = (
      method: "GET" | "POST",
      authorization: string,
      remoteAddress = "127.0.0.1"
    ) =>
      app.inject({
        method,
        url: method === "GET" ? "/v1/agents" : "/v1/agents/chief:ensure",
        payload:
          method === "POST"
            ? { aiClientInstanceId: "codex.default" }
            : undefined,
        headers: { authorization },
        remoteAddress
      });
    try {
      expect((await send("GET", readOnly.authorization)).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/agents/bootstrap-context",
            headers: { authorization: readOnly.authorization },
            remoteAddress: "127.0.0.1"
          })
        ).statusCode
      ).toBe(200);
      expect((await send("POST", readOnly.authorization)).statusCode).toBe(401);
      expect(
        (await send("GET", `${readOnly.authorization}forged`)).statusCode
      ).toBe(401);
      expect(
        (await send("GET", readOnly.authorization, "10.0.0.1")).statusCode
      ).toBe(403);
      expect(repository.ensureChief).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
      deleteDesktopLocalCredential(home);
      expect((await send("GET", readOnly.authorization)).statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("accepts the existing write family on local Desktop and declares local-only route identities", async () => {
    const home = mkdtempSync(join(scratch, "koed-agents-write-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: owner,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const { app, repository } = fixture("developer", home);
    try {
      const result = await app.inject({
        method: "POST",
        url: "/v1/agents/chief:ensure",
        payload: { aiClientInstanceId: "codex.default" },
        headers: { authorization: credential.authorization },
        remoteAddress: "127.0.0.1"
      });
      expect(result.statusCode).toBe(200);
      expect(repository.ensureChief).toHaveBeenCalledWith(
        owner,
        "codex.default"
      );
      for (const [method, path] of [
        ["GET", "/v1/agents/bootstrap-context"],
        ["GET", "/v1/agents"],
        ["POST", "/v1/agents/chief:ensure"],
        ["POST", "/v1/agents"],
        ["PATCH", "/v1/agents/{id}"]
      ] as const) {
        const contract = routeIdentityFor(method, path);
        expect(contract?.identity).toBe("session_or_device_credential");
        expect(contract?.deploymentModes).toEqual([
          "developer",
          "local_personal"
        ]);
      }
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
