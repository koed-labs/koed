import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { registerHomeRoutes } from "./routes.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const item = {
  sourceEventId: "runtime:22222222-2222-4222-8222-222222222222",
  source: "managed_runtime_item" as const,
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceRevision: "r2",
  kind: "question" as const,
  state: "blocked" as const,
  title: "Agent question needs an answer",
  summary: null,
  updatedAt: "2026-10-02T10:00:00.000Z",
  destination: {
    kind: "execution" as const,
    executionId: "33333333-3333-4333-8333-333333333333"
  }
};

const apps: Array<Awaited<ReturnType<typeof Fastify>>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const writeHomeUpstreamRegistry = () => {
  const path = resolve(
    mkdtempSync(resolve(tmpdir(), "koed-home-upstream-")),
    "upstream.json"
  );
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-10-02T10:00:00.000Z",
      activeBackendId: "home-authority",
      backends: [
        {
          id: "home-authority",
          displayName: "Home authority",
          baseUrl: "https://home.example.test/koed",
          profile: "private_vps",
          createdAt: "2026-10-02T10:00:00.000Z",
          updatedAt: "2026-10-02T10:00:00.000Z",
          routePolicy: { managedExecution: "enabled" },
          credential: { status: "configured" },
          capabilities: {
            state: "validated",
            checkedAt: "2026-10-02T10:00:00.000Z",
            expiresAt: "2099-10-02T10:00:00.000Z",
            schemaVersion: 3,
            profile: "private_vps",
            payload: {
              capabilities: {
                "memory.managedConversations": { availability: "available" }
              }
            }
          }
        }
      ]
    })
  );
  return path;
};

const buildApp = (
  input: {
    current?: typeof item;
    authenticated?: boolean;
    profile?: string;
    upstreamBackendsPath?: string;
    remoteOperationsAllowed?: boolean;
    fetch?: typeof globalThis.fetch;
  } = {}
) => {
  const states = new Map<
    string,
    {
      ownerUserId: string;
      sourceEventId: string;
      source: typeof item.source;
      sourceId: string;
      sourceRevision: string;
      cleared: boolean;
      updatedAt: string;
    }[]
  >();
  const home = {
    listSourcePage: vi.fn(
      async (request: {
        ownerUserId: string;
        source:
          | typeof item.source
          | "managed_execution"
          | "personal_agent_job"
          | "pull_request_review";
      }) => ({
        items:
          request.ownerUserId === ownerId &&
          input.current?.source === request.source
            ? [input.current]
            : [],
        complete: true,
        nextCursor: null
      })
    ),
    countNeedsYou: vi.fn(async (userId: string) => {
      const currentState = states
        .get(userId)
        ?.find((row) => row.sourceEventId === input.current?.sourceEventId);
      return userId === ownerId && input.current && !currentState?.cleared
        ? 1
        : 0;
    }),
    listReminderStates: vi.fn(
      async (userId: string) => states.get(userId) ?? []
    ),
    setReminderState: vi.fn(
      async (state: {
        ownerUserId: string;
        sourceEventId: string;
        source: typeof item.source;
        sourceId: string;
        sourceRevision: string;
        cleared: boolean;
      }) => {
        if (
          input.current?.sourceEventId !== state.sourceEventId ||
          input.current.sourceRevision !== state.sourceRevision
        )
          throw Object.assign(new Error("stale"), { statusCode: 409 });
        const rows = states.get(state.ownerUserId) ?? [];
        const next = { ...state, updatedAt: "2026-10-02T10:01:00.000Z" };
        states.set(state.ownerUserId, [
          next,
          ...rows.filter((row) => row.sourceEventId !== state.sourceEventId)
        ]);
        return next;
      }
    )
  };
  const app = Fastify();
  apps.push(app);
  registerHomeRoutes(app, {
    config: { deploymentProfile: input.profile ?? "koed_managed_cloud" },
    home,
    auth: {
      authenticate: vi.fn(async () => {
        if (!input.authenticated)
          throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        return { id: ownerId };
      }),
      authenticateSession: vi.fn(async () => {
        if (!input.authenticated)
          throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        return { id: ownerId };
      }),
      authenticateApiToken: vi.fn(async () => ({ id: ownerId })),
      authenticateSessionOrDeviceCredential: vi.fn(async () => ({
        id: ownerId
      }))
    },
    deploymentIdentity: {
      inspect: () => ({ deploymentId: "home-test-deployment" })
    },
    localEdge: {
      upstreamBackendsPath: input.upstreamBackendsPath ?? "/no-upstream",
      remoteOperationsAllowed: () => input.remoteOperationsAllowed ?? false,
      resolveUpstreamAuthorization: vi.fn(() => "Koed-Device home-enrolled"),
      fetch: input.fetch ?? globalThis.fetch
    }
  } as never);
  return { app, home, states };
};

describe("Home routes", () => {
  it("returns owner-scoped current items and counts only uncleared reminders", async () => {
    const { app } = buildApp({ current: item, authenticated: true });
    const response = await app.inject({ method: "GET", url: "/v1/home" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      needsYou: [item],
      cleared: [],
      badgeCount: 1,
      accountScope: expect.any(String)
    });
  });

  it("returns the effective owner scope before loading Home content", async () => {
    const { app } = buildApp({ authenticated: true });
    const response = await app.inject({
      method: "GET",
      url: "/v1/home/access"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountScope: expect.any(String),
      backendId: "home-test-deployment"
    });
  });

  it("accepts the current local API-token principal and limits a cursor request to its selected source", async () => {
    const { app, home } = buildApp({
      current: item,
      authenticated: true,
      profile: "developer"
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/home?source=managed_runtime_item&limit=1"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().coverage).toEqual([
      { source: "managed_runtime_item", complete: true, nextCursor: null }
    ]);
    expect(home.listSourcePage).toHaveBeenCalledTimes(1);
    expect(home.listSourcePage).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: ownerId,
        source: "managed_runtime_item",
        limit: 1
      })
    );
  });

  it("uses the enrolled upstream owner for access and reminder writes", async () => {
    const remoteItem = {
      sourceEventId: item.sourceEventId,
      sourceRevision: item.sourceRevision,
      cleared: true
    };
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = new URL(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Koed-Device home-enrolled"
        );
        if (target.pathname.endsWith("/v1/home/access")) {
          return new Response(
            JSON.stringify({
              accountScope: "hosted-owner-scope",
              backendId: "hosted-deployment"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        expect(decodeURIComponent(target.pathname)).toBe(
          `/koed/v1/home/reminders/${item.sourceEventId}/clear`
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          sourceRevision: item.sourceRevision
        });
        return new Response(JSON.stringify(remoteItem), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    ) as unknown as typeof globalThis.fetch;
    const { app, home } = buildApp({
      authenticated: true,
      profile: "developer",
      upstreamBackendsPath: writeHomeUpstreamRegistry(),
      remoteOperationsAllowed: true,
      fetch
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/home/access"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accountScope: "hosted-owner-scope",
      backendId: "hosted-deployment"
    });
    const clear = await app.inject({
      method: "POST",
      url: `/v1/home/reminders/${item.sourceEventId}/clear`,
      payload: { sourceRevision: item.sourceRevision }
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual(remoteItem);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(home.listSourcePage).not.toHaveBeenCalled();
    expect(home.setReminderState).not.toHaveBeenCalled();
  });

  it("does not fall back to local Home when a configured upstream fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("upstream unavailable");
    }) as unknown as typeof globalThis.fetch;
    const { app, home } = buildApp({
      current: item,
      authenticated: true,
      profile: "developer",
      upstreamBackendsPath: writeHomeUpstreamRegistry(),
      remoteOperationsAllowed: true,
      fetch
    });
    const response = await app.inject({ method: "GET", url: "/v1/home" });
    expect(response.statusCode).not.toBe(200);
    expect(home.listSourcePage).not.toHaveBeenCalled();
    expect(home.countNeedsYou).not.toHaveBeenCalled();
  });

  it("clears and restores only the exact current revision across requests", async () => {
    const { app, home } = buildApp({ current: item, authenticated: true });
    const url = `/v1/home/reminders/${item.sourceEventId}/clear`;
    const clear = await app.inject({
      method: "POST",
      url,
      payload: { sourceRevision: item.sourceRevision }
    });
    expect(clear.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/home" })).json()
    ).toMatchObject({
      needsYou: [],
      cleared: [item],
      badgeCount: 0
    });
    const restore = await app.inject({
      method: "POST",
      url: `/v1/home/reminders/${item.sourceEventId}/restore`,
      payload: { sourceRevision: item.sourceRevision }
    });
    expect(restore.statusCode).toBe(200);
    expect(home.setReminderState).toHaveBeenCalledTimes(2);
  });

  it("fails closed for unauthenticated callers and stale source revisions", async () => {
    const anonymous = buildApp({ current: item });
    expect(
      (await anonymous.app.inject({ method: "GET", url: "/v1/home" }))
        .statusCode
    ).toBe(401);
    const { app, home } = buildApp({
      current: { ...item, sourceRevision: "r3" },
      authenticated: true
    });
    const stale = await app.inject({
      method: "POST",
      url: `/v1/home/reminders/${item.sourceEventId}/clear`,
      payload: { sourceRevision: "r2" }
    });
    expect(stale.statusCode).toBe(409);
    expect(home.setReminderState).toHaveBeenCalledTimes(1);
  });
});
