import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { registerScheduledJobRoutes } from "./routes.js";

const owner = randomUUID(),
  deviceId = randomUUID(),
  agentId = randomUUID(),
  conversationSessionId = randomUUID();
const jobInput = () => ({
  requestId: randomUUID(),
  agentId,
  conversationSessionId,
  projectId: null,
  title: "Daily check",
  instruction: "Review the plan",
  schedule: { kind: "daily", at: "09:00", tz: "Europe/Oslo" }
});
const fixture = (home: string, health: "healthy" | "unhealthy" = "healthy") => {
  const app = Fastify();
  const create = vi.fn(async () => ({ id: randomUUID() }));
  const auth = vi.fn(async () => ({ id: owner }));
  registerScheduledJobRoutes(
    app,
    {
      config: { deploymentProfile: "local_personal", koedHome: home },
      deploymentIdentity: {
        inspect: () => ({
          health,
          deviceInstanceId: deviceId,
          deploymentId: randomUUID()
        })
      },
      auth: { authenticateSessionOrDeviceCredential: auth },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as never,
    { create } as never
  );
  return { app, create, auth };
};
describe("Scheduled Job route identity and validation", () => {
  it("derives the first device from a healthy local Desktop identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq601-route-"));
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const { app, create } = fixture(home);
      const input = jobInput();
      const response = await app.inject({
        method: "POST",
        url: "/v1/scheduled-jobs",
        headers: { authorization: credential.authorization },
        remoteAddress: "127.0.0.1",
        payload: input
      });
      expect(response.statusCode).toBe(201);
      expect(create).toHaveBeenCalledWith(owner, deviceId, input);
      const remote = await app.inject({
        method: "POST",
        url: "/v1/scheduled-jobs",
        headers: { authorization: credential.authorization },
        remoteAddress: "192.0.2.1",
        payload: jobInput()
      });
      expect(remote.statusCode).toBe(403);
      expect(create).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("rejects session-only creation and unhealthy device identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq601-route-"));
    try {
      const { app, create } = fixture(home);
      const session = await app.inject({
        method: "POST",
        url: "/v1/scheduled-jobs",
        payload: jobInput()
      });
      expect(session.statusCode).toBe(403);
      expect(create).not.toHaveBeenCalled();
      await app.close();
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const unhealthy = fixture(home, "unhealthy");
      const denied = await unhealthy.app.inject({
        method: "POST",
        url: "/v1/scheduled-jobs",
        headers: { authorization: credential.authorization },
        payload: jobInput()
      });
      expect(denied.statusCode).toBe(503);
      await unhealthy.app.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("rejects malformed schedule variants before persistence", async () => {
    const home = mkdtempSync(join(tmpdir(), "koed-hq601-route-"));
    try {
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: owner,
        operationFamilies: ["personal_collaboration_write", "managed_execution"]
      });
      const { app, create } = fixture(home);
      for (const schedule of [
        { kind: "daily", at: "24:00", tz: "UTC" },
        { kind: "weekly", at: "09:00", tz: "UTC", dow: [1, 1] },
        { kind: "monthly", at: "09:00", tz: "UTC", dom: 32 },
        { kind: "weekdays", at: "09:00", tz: "+02:00" }
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/scheduled-jobs",
          headers: { authorization: credential.authorization },
          payload: { ...jobInput(), schedule }
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
      }
      const override = await app.inject({
        method: "POST",
        url: "/v1/scheduled-jobs",
        headers: { authorization: credential.authorization },
        payload: { ...jobInput(), runnerDeviceId: randomUUID() }
      });
      expect(override.statusCode).toBeGreaterThanOrEqual(400);
      expect(create).not.toHaveBeenCalled();
      await app.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
