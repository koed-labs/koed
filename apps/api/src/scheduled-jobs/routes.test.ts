import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const expired = vi.fn(async () => []);
  const runtimeCandidates = vi.fn(async () => []);
  const materialize = vi.fn();
  const requireRepository = vi.fn(() => ({}));
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
      localEdge: { upstreamBackendsPath: join(home, "upstream-backends.json") },
      requireRepository,
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as never,
    {
      create,
      listExpiredManagedCommands: expired,
      listActiveManagedCommands: async () => [],
      listTerminalManagedCommands: async () => [],
      listInterruptedManagedCommandsAwaitingProviderAck: async () => [],
      listRuntimeCandidates: runtimeCandidates,
      listPendingRuntimeRuns: async () => [],
      materializeScheduledOccurrence: materialize
    } as never,
    { bootstrapContext: async () => ({ enabledInstances: [] }) } as never,
    async () => {
      throw new Error("No linked Job expected in this fixture");
    }
  );
  return {
    app,
    create,
    auth,
    expired,
    runtimeCandidates,
    materialize,
    requireRepository
  };
};
describe("Scheduled Job route identity and validation", () => {
  it.each(["enabled", "disabled"] as const)(
    "does not queue local work when selected remote Managed authority is %s",
    async (managedExecution) => {
      const home = mkdtempSync(join(tmpdir(), "koed-hq602-authority-"));
      const state = fixture(home);
      try {
        const credential = storeDesktopLocalCredential(home, {
          ownerUserId: owner,
          operationFamilies: [
            "personal_collaboration_write",
            "managed_execution"
          ]
        });
        writeFileSync(
          join(home, "upstream-backends.json"),
          JSON.stringify({
            schemaVersion: 2,
            activeBackendId: "remote",
            backends: [
              {
                id: "remote",
                baseUrl: "https://managed.example.test",
                routePolicy: { managedExecution }
              }
            ]
          })
        );
        const response = await state.app.inject({
          method: "POST",
          url: "/v1/scheduled-jobs/runtime/tick",
          headers: { authorization: credential.authorization },
          remoteAddress: "127.0.0.1",
          payload: {}
        });
        if (managedExecution === "enabled") {
          expect(response.statusCode).toBe(503);
          expect(state.expired).not.toHaveBeenCalled();
          expect(state.runtimeCandidates).not.toHaveBeenCalled();
          expect(state.requireRepository).not.toHaveBeenCalled();
        } else {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({
            materialized: 0,
            dispatched: 0,
            needsReview: 0,
            reconciled: 0
          });
          expect(state.runtimeCandidates).toHaveBeenCalledOnce();
        }
        expect(state.materialize).not.toHaveBeenCalled();
      } finally {
        await state.app.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

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
