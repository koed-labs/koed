import cookie from "@fastify/cookie";
import Fastify, { type HTTPMethods } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  isHighRiskBrowserWrite,
  registerBrowserWriteCsrfProtection
} from "./browser-write-csrf.js";

const allowedOrigin = "https://app.example.test";
const secondAllowedOrigin = "https://admin.example.test";
const sessionCookie = "cm_session=session-secret";

const protectedWrites = [
  ["POST", "/v1/high-risk/browser-activations/selector/decision"],
  ["POST", "/v1/shared-memory/pending-shares"],
  ["POST", "/v1/retention/legal-holds"],
  ["POST", "/v1/teams"],
  ["PUT", "/v1/team-workspaces/workspace-id/access"],
  ["POST", "/v1/team-invites/accept"]
] as const satisfies ReadonlyArray<readonly [HTTPMethods, string]>;
const ordinaryBrowserWrite =
  "/v1/collaboration/teams/00000000-0000-4000-8000-000000000001/threads/00000000-0000-4000-8000-000000000002/messages";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildTestServer = async () => {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  registerBrowserWriteCsrfProtection(
    app,
    new Set([allowedOrigin, secondAllowedOrigin])
  );
  for (const [method, url] of protectedWrites) {
    app.route({
      method,
      url,
      handler: async (_request, reply) => reply.status(204).send()
    });
  }
  app.post(ordinaryBrowserWrite, async (_request, reply) =>
    reply.status(204).send()
  );
  await app.ready();
  return app;
};

describe("high-risk browser write CSRF protection", () => {
  it.each(protectedWrites)(
    "allows same-origin browser session %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: {
          cookie: sessionCookie,
          origin: allowedOrigin,
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(204);
    }
  );

  it("requires origin evidence for ordinary session-cookie writes", async () => {
    const app = await buildTestServer();

    const missingOrigin = await app.inject({
      method: "POST",
      url: ordinaryBrowserWrite,
      headers: { cookie: sessionCookie }
    });
    const sameOrigin = await app.inject({
      method: "POST",
      url: ordinaryBrowserWrite,
      headers: {
        cookie: sessionCookie,
        origin: allowedOrigin,
        "sec-fetch-site": "same-origin"
      }
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(sameOrigin.statusCode).toBe(204);
  });

  it.each(protectedWrites)(
    "allows matching allowlisted Origin and Referer for %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: {
          cookie: sessionCookie,
          origin: allowedOrigin,
          referer: `${allowedOrigin}/settings`,
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(204);
    }
  );

  it.each(protectedWrites)(
    "accepts an allowlisted Referer fallback for %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: {
          cookie: sessionCookie,
          referer: `${allowedOrigin}/settings`,
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(204);
    }
  );

  it.each(protectedWrites)(
    "rejects a disallowed Origin for browser session %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: {
          cookie: sessionCookie,
          origin: "https://evil.example.test",
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(403);
    }
  );

  it.each(protectedWrites)(
    "rejects a disallowed Referer for browser session %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: {
          cookie: sessionCookie,
          referer: "https://evil.example.test/settings",
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(403);
    }
  );

  it.each(protectedWrites)(
    "fails closed without origin evidence for browser session %s %s",
    async (method, url) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method,
        url,
        headers: { cookie: sessionCookie }
      });

      expect(response.statusCode).toBe(403);
    }
  );

  it.each(["same-site", "cross-site", "none", "SAME-ORIGIN", "unknown", ""])(
    "rejects %s Fetch Metadata on every high-risk browser write",
    async (fetchSite) => {
      for (const [method, url] of protectedWrites) {
        const app = await buildTestServer();
        const response = await app.inject({
          method,
          url,
          headers: {
            cookie: sessionCookie,
            origin: allowedOrigin,
            "sec-fetch-site": fetchSite
          }
        });

        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
  );

  it("rejects mismatched Origin and Referer even when each is allowlisted", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/pending-shares",
      headers: {
        cookie: sessionCookie,
        origin: allowedOrigin,
        referer: `${secondAllowedOrigin}/settings`,
        "sec-fetch-site": "same-origin"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it.each([
    {
      name: "malformed Origin",
      headers: { origin: "not a URL", referer: `${allowedOrigin}/settings` }
    },
    {
      name: "opaque Origin",
      headers: { origin: "null", referer: `${allowedOrigin}/settings` }
    },
    {
      name: "multiple Origin values",
      headers: {
        origin: `${allowedOrigin}, ${secondAllowedOrigin}`,
        referer: `${allowedOrigin}/settings`
      }
    },
    {
      name: "non-origin Origin URL",
      headers: {
        origin: `${allowedOrigin}/path`,
        referer: `${allowedOrigin}/settings`
      }
    },
    {
      name: "malformed Referer",
      headers: { origin: allowedOrigin, referer: "not a URL" }
    },
    {
      name: "disallowed Origin with allowed Referer",
      headers: {
        origin: "https://evil.example.test",
        referer: `${allowedOrigin}/settings`
      }
    },
    {
      name: "allowed Origin with disallowed Referer",
      headers: {
        origin: allowedOrigin,
        referer: "https://evil.example.test/settings"
      }
    }
  ])(
    "rejects $name instead of trusting the other header",
    async ({ headers }) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method: "POST",
        url: "/v1/shared-memory/pending-shares",
        headers: {
          cookie: sessionCookie,
          ...headers,
          "sec-fetch-site": "same-origin"
        }
      });

      expect(response.statusCode).toBe(403);
    }
  );

  it("accepts missing Fetch Metadata when valid same-origin evidence remains", async () => {
    const app = await buildTestServer();
    const response = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/pending-shares",
      headers: {
        cookie: sessionCookie,
        origin: allowedOrigin,
        referer: `${allowedOrigin}/settings`
      }
    });

    expect(response.statusCode).toBe(204);
  });

  it.each(["Bearer api-token", "Koed-Device device-id:secret"])(
    "does not require browser evidence for non-browser %s writes",
    async (authorization) => {
      const app = await buildTestServer();
      const response = await app.inject({
        method: "POST",
        url: "/v1/shared-memory/pending-shares",
        headers: { authorization }
      });

      expect(response.statusCode).toBe(204);
    }
  );

  it("matches only unsafe methods in protected route families", () => {
    expect(
      isHighRiskBrowserWrite("PATCH", "/v1/teams/team-id/members/id/role")
    ).toBe(true);
    expect(isHighRiskBrowserWrite("GET", "/v1/teams/team-id/members")).toBe(
      false
    );
    expect(isHighRiskBrowserWrite("POST", "/v1/teamship")).toBe(false);
  });
});
