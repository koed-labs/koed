import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import express from "express";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthError as AuthorizationServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { remoteMcpScopes, type RemoteMcpOAuth } from "./remote-mcp-oauth.js";
import { sessionCookieName, type AuthHelpers } from "./session.js";

const consentPath = "/auth/mcp/authorize";
const csrfCookie = "koed_mcp_consent";
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!
  );
const forbidden = () =>
  Object.assign(new Error("Invalid authorization consent"), {
    statusCode: 403
  });
const requestSecretFor = (request: FastifyRequest) => {
  const value = (request.query as { request?: unknown })?.request;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw Object.assign(new Error("Invalid authorization request"), {
      statusCode: 400
    });
  return value;
};
const browserHeaders = (reply: FastifyReply, nonce: string) => {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
  );
  reply.type("text/html; charset=utf-8");
};
const page = (nonce: string, content: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Koed</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;color:#1c2521;background:#f7f9f8;margin:0}main{max-width:560px;padding:40px 24px;margin:40px auto}h1{font-size:28px}p,li{line-height:1.5;overflow-wrap:anywhere}label{display:block;margin-top:20px}input{box-sizing:border-box;width:100%;padding:10px;margin-top:6px;border:1px solid #adb9b1;border-radius:4px;font:inherit}button{padding:10px 18px;margin:16px 12px 0 0;border:1px solid #61756a;border-radius:4px;background:#fff;color:#1c2521;font:inherit;cursor:pointer}button[value=allow],button[type=submit]{background:#205c42;color:white}small{color:#4a5b52;overflow-wrap:anywhere}#error{color:#9e2424}</style></head><body><main>${content}</main></body></html>`;
const scopeLabels: Record<string, string> = {
  "koed:memory:read": "Read your Personal Memory",
  "koed:team:read": "Read Team Workspace memory you currently have access to",
  "koed:capture":
    "Capture conversations and access your Conversation Source Journal",
  "koed:local-execution":
    "Run local AI-client memory work for your Personal Memory"
};

export const registerRemoteMcpOAuthRoutes = (
  app: FastifyInstance,
  options: {
    oauth: RemoteMcpOAuth;
    issuerUrl: URL;
    auth: AuthHelpers;
    workosAvailable: boolean;
    publicOrigin: string;
  }
) => {
  const publicOrigin = new URL(options.publicOrigin).origin;
  if (publicOrigin !== options.issuerUrl.origin)
    throw new Error("OAuth public origin must match its issuer");
  const sdkApp = express();
  sdkApp.disable("x-powered-by");
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanup: Promise<void> | undefined;
  const pruneExpired = () => {
    if (!cleanup)
      cleanup = options.oauth
        .pruneExpired()
        .catch(() => app.log.error("Remote MCP OAuth cleanup failed"))
        .finally(() => {
          cleanup = undefined;
        });
    return cleanup;
  };
  app.addHook("onReady", async () => {
    await pruneExpired();
    cleanupTimer = setInterval(() => void pruneExpired(), 5 * 60_000);
    cleanupTimer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(cleanupTimer);
    await cleanup;
  });
  sdkApp.use(
    "/.well-known/oauth-authorization-server",
    (_request, response, next) => {
      const json = response.json.bind(response);
      response.json = (metadata: Record<string, unknown>) =>
        json({
          ...metadata,
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"]
        });
      next();
    }
  );
  sdkApp.use(
    mcpAuthRouter({
      provider: options.oauth.provider,
      issuerUrl: options.issuerUrl,
      resourceServerUrl: new URL("/mcp", options.issuerUrl),
      scopesSupported: [...remoteMcpScopes],
      resourceName: "Koed"
    })
  );
  const hashBinding = (
    request: FastifyRequest,
    userId: string,
    pending: string,
    token: string
  ) =>
    options.auth.hashSecret(
      JSON.stringify([
        request.cookies[sessionCookieName],
        userId,
        pending,
        token
      ])
    );
  const sameOrigin = (request: FastifyRequest) => {
    if (
      request.headers["sec-fetch-site"] &&
      request.headers["sec-fetch-site"] !== "same-origin"
    )
      return false;
    const origin = request.headers.origin;
    if (origin !== undefined) return origin === publicOrigin;
    const referer = request.headers.referer;
    if (!referer) return false;
    try {
      return new URL(referer).origin === publicOrigin;
    } catch {
      return false;
    }
  };

  app.register((routes, _pluginOptions, done) => {
    routes.addHook("onRequest", (_request, reply, next) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      next();
    });
    routes.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        const parsed: Record<string, string | string[]> = Object.create(
          null
        ) as Record<string, string | string[]>;
        for (const [key, value] of new URLSearchParams(String(body))) {
          const prior = parsed[key];
          parsed[key] =
            prior === undefined
              ? value
              : Array.isArray(prior)
                ? [...prior, value]
                : [prior, value];
        }
        done(null, parsed);
      }
    );
    for (const url of [
      "/authorize",
      "/token",
      "/register",
      "/revoke",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp"
    ]) {
      routes.all(url, async (request, reply) => {
        reply.raw.setHeader("cache-control", "no-store");
        reply.raw.setHeader("referrer-policy", "no-referrer");
        const raw = request.raw as IncomingMessage & { body?: unknown };
        raw.body = request.body;
        reply.hijack();
        sdkApp(raw, reply.raw);
      });
    }

    routes.get(consentPath, async (request, reply) => {
      const pending = requestSecretFor(request);
      const consent = await options.oauth.getAuthorizationRequest(pending);
      if (!consent)
        return reply
          .status(400)
          .send({ error: "Authorization request expired or already used" });
      let user: Awaited<ReturnType<AuthHelpers["authenticateSession"]>>;
      try {
        user = await options.auth.authenticateSession(request);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            error.statusCode === 401
          )
        )
          throw error;
        if (options.workosAvailable) {
          reply.header("cache-control", "no-store");
          reply.header("referrer-policy", "no-referrer");
          const returnTo = `${consentPath}?${new URLSearchParams({ request: pending })}`;
          return reply.redirect(
            `/auth/workos/login?${new URLSearchParams({ return_to: returnTo })}`
          );
        }
        const nonce = randomBytes(18).toString("base64url");
        browserHeaders(reply, nonce);
        return reply.send(
          page(
            nonce,
            `<h1>Sign in to Koed</h1><form id="login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button><p id="error" role="alert"></p></form><script nonce="${nonce}">document.getElementById('login').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({email:form.elements.email.value,password:form.elements.password.value})});if(!response.ok){document.getElementById('error').textContent='Sign-in failed';return;}location.reload();}catch{document.getElementById('error').textContent='Sign-in unavailable';}finally{button.disabled=false;}});</script>`
          )
        );
      }
      const token = randomBytes(32).toString("base64url");
      reply.setCookie(
        csrfCookie,
        hashBinding(request, user.id, pending, token),
        {
          httpOnly: true,
          secure: options.issuerUrl.protocol === "https:",
          sameSite: "strict",
          path: consentPath,
          maxAge: 10 * 60
        }
      );
      const nonce = randomBytes(18).toString("base64url");
      browserHeaders(reply, nonce);
      return reply.send(
        page(
          nonce,
          `<h1>Authorize AI Client</h1><p>${escapeHtml(consent.clientName)}</p><small>Client ${escapeHtml(consent.clientId)}</small><p>Signed in as ${escapeHtml(user.email)}</p><p>${escapeHtml(consent.resource)}</p><ul>${consent.scopes.map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`).join("")}</ul><form method="post" action="${consentPath}?${new URLSearchParams({ request: pending })}"><input type="hidden" name="csrfToken" value="${token}"><button name="decision" value="allow" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button></form>`
        )
      );
    });

    routes.post(consentPath, async (request, reply) => {
      const pending = requestSecretFor(request);
      const user = await options.auth.authenticateSession(request);
      const body = request.body as {
        csrfToken?: unknown;
        decision?: unknown;
      } | null;
      const token = body?.csrfToken;
      const cookie = request.cookies[csrfCookie];
      if (
        !request.cookies[sessionCookieName] ||
        !sameOrigin(request) ||
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof cookie !== "string" ||
        (body?.decision !== "allow" && body?.decision !== "deny")
      )
        throw forbidden();
      const expected = Buffer.from(
        hashBinding(request, user.id, pending, token)
      );
      const received = Buffer.from(cookie);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw forbidden();
      let completed: { redirectUrl: string };
      try {
        completed = await options.oauth.completeAuthorization({
          requestSecret: pending,
          userId: user.id,
          approved: body.decision === "allow"
        });
      } catch (error) {
        if (error instanceof AuthorizationServerError)
          return reply.status(400).send(error.toResponseObject());
        throw error;
      }
      reply.clearCookie(csrfCookie, { path: consentPath });
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      return reply.redirect(completed.redirectUrl);
    });
    done();
  });
  return { close: () => Promise.resolve() };
};
