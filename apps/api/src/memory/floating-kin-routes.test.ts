import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { ApiRouteContext } from "../server/context.js";
import { registerFloatingKinRoutes } from "./floating-kin-routes.js";

it("requires a Personal API Token and the local runtime credential for activity and evidence", async () => {
  const scratch = fileURLToPath(
    new URL("../../../../scratch/", import.meta.url)
  );
  await mkdir(scratch, { recursive: true });
  const koedHome = await mkdtemp(join(scratch, "floating-kin-api-"));
  const app = Fastify();
  const userId = randomUUID();
  const input = { sessionId: randomUUID(), action: "conversation" };
  const runtimeAuthorization = `Bearer ${"a".repeat(43)}`;
  const activity = vi.fn(async () => ({ conversations: [], overflowCount: 0 }));
  const evidence = vi.fn(async () => ({ items: [], truncated: false }));
  let kind = "delegated";
  const config = { koedHome, deploymentProfile: "local_personal" };
  try {
    await mkdir(join(koedHome, "run"));
    await writeFile(
      join(koedHome, "run", "local-ai-runtime.json"),
      JSON.stringify({
        protocolVersion: 1,
        authorization: runtimeAuthorization,
        pid: process.pid,
        url: "http://127.0.0.1:4000"
      }),
      { mode: 0o600 }
    );
    registerFloatingKinRoutes(app, {
      config,
      requireRepository: () => ({
        getFloatingKinActivity: activity,
        getFloatingKinEvidence: evidence
      }),
      auth: {
        authenticateApiToken: async () => ({ id: userId }),
        authenticatedCredentialKind: () => kind
      },
      rateLimit: { memoryRead: async () => {} }
    } as unknown as ApiRouteContext);
    const get = (
      token?: string,
      remoteAddress = "127.0.0.1",
      host = "127.0.0.1"
    ) =>
      app.inject({
        url: "/v1/memory/floating-kin/activity",
        remoteAddress,
        headers: {
          host,
          ...(token ? { "x-koed-local-runtime-authorization": token } : {})
        }
      });
    const post = (token?: string, remoteAddress = "127.0.0.1") =>
      app.inject({
        method: "POST",
        remoteAddress,
        url: "/v1/memory/floating-kin/evidence",
        payload: input,
        headers: {
          host: "127.0.0.1",
          ...(token ? { "x-koed-local-runtime-authorization": token } : {})
        }
      });
    expect((await get(runtimeAuthorization)).statusCode).toBe(403);
    expect((await post(runtimeAuthorization)).statusCode).toBe(403);
    expect(activity).not.toHaveBeenCalled();
    kind = "api_token";
    expect((await get()).statusCode).toBe(403);
    expect((await get("Bearer bad")).statusCode).toBe(403);
    expect((await get(runtimeAuthorization, "192.0.2.1")).statusCode).toBe(403);
    expect(
      (await get(runtimeAuthorization, "127.0.0.1", "example.invalid"))
        .statusCode
    ).toBe(403);
    expect((await post()).statusCode).toBe(403);
    expect((await post("Bearer bad")).statusCode).toBe(403);
    expect((await post(runtimeAuthorization, "192.0.2.1")).statusCode).toBe(
      403
    );
    config.deploymentProfile = "hosted_team";
    expect((await get(runtimeAuthorization)).statusCode).toBe(403);
    expect((await post(runtimeAuthorization)).statusCode).toBe(403);
    expect(activity).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
    config.deploymentProfile = "local_personal";
    const activityResult = await get(runtimeAuthorization, "::1");
    expect(activityResult.statusCode).toBe(200);
    expect(activityResult.headers["cache-control"]).toBe("no-store");
    expect(activity).toHaveBeenCalledWith({ userId });
    expect((await post(runtimeAuthorization)).headers["cache-control"]).toBe(
      "no-store"
    );
    expect(evidence).toHaveBeenCalledWith({ userId }, input);
    expect((await post(runtimeAuthorization, "::1")).statusCode).toBe(200);
  } finally {
    await app.close();
    await rm(koedHome, { recursive: true, force: true });
  }
});
