import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLocalAgentSettingsRoutes } from "./local-agent-settings-routes.js";
import type { ApiRouteContext } from "../server/context.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwnerId = "22222222-2222-4222-8222-222222222222";
const deviceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("AI Client instance publication routes", () => {
  it("binds publications to the authenticated device and rejects client-supplied device links", async () => {
    const instances = new Map<string, Record<string, unknown>>();
    const snapshots: Array<Record<string, unknown>> = [];
    const repo = {
      listAiClientInstances: async ({ userId }: { userId: string }) =>
        [...instances.values()].filter(
          (instance) => instance.ownerUserId === userId
        ),
      listAiClientCapabilitySnapshots: async ({ userId }: { userId: string }) =>
        snapshots.filter((snapshot) => snapshot.ownerUserId === userId),
      listCurrentAiClientCapabilitySnapshots: async ({
        userId
      }: {
        userId: string;
      }) => snapshots.filter((snapshot) => snapshot.ownerUserId === userId),
      listLocalMemoryAgentSettings: async () => [],
      upsertAiClientInstance: async (
        { userId }: { userId: string },
        input: Record<string, unknown>
      ) => {
        const key = `${userId}:${input.instanceId}:${input.sourceDeviceCredentialId ?? "local"}`;
        const previous = instances.get(key);
        const instance = {
          ownerUserId: userId,
          ...input,
          enabled:
            input.enabled !== undefined
              ? input.enabled
              : (previous?.enabled ?? true),
          hostedInstanceId: `runner.${String(input.sourceDeviceCredentialId).replaceAll("-", "")}`
        };
        instances.set(key, instance);
        return instance;
      },
      setAiClientInstanceEnabled: async (
        { userId }: { userId: string },
        input: { hostedInstanceId: string; enabled: boolean }
      ) => {
        const target = [...instances.values()].find(
          (instance) =>
            instance.ownerUserId === userId &&
            instance.hostedInstanceId === input.hostedInstanceId
        );
        if (!target) return null;
        Object.assign(target, { enabled: input.enabled });
        return target;
      },
      recordAiClientCapabilitySnapshot: async (
        { userId }: { userId: string },
        input: Record<string, unknown>
      ) => {
        const snapshot = {
          ownerUserId: userId,
          hostedInstanceId: `runner.${String(input.sourceDeviceCredentialId).replaceAll("-", "")}`,
          ...input
        };
        snapshots.push(snapshot);
        return snapshot;
      }
    };
    const credentials: Record<
      string,
      { userId: string; deviceId: string; label: string; families: string[] }
    > = {
      "runner-a:secret": {
        userId: ownerId,
        deviceId: deviceA,
        label: "Runner A",
        families: ["ai_client_capability_publish"]
      },
      "runner-b:secret": {
        userId: ownerId,
        deviceId: deviceB,
        label: "Runner B",
        families: ["ai_client_capability_publish"]
      },
      "wrong-scope:secret": {
        userId: ownerId,
        deviceId: deviceB,
        label: "Runner B",
        families: ["managed_execution"]
      },
      "runner-c:secret": {
        userId: ownerId,
        deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        label: "Runner C",
        families: ["ai_client_capability_publish"]
      },
      "other-owner:secret": {
        userId: otherOwnerId,
        deviceId: deviceA,
        label: "Other owner runner",
        families: ["ai_client_capability_publish"]
      }
    };
    const app = Fastify();
    const config = { deploymentProfile: "team_self_hosted" };
    registerLocalAgentSettingsRoutes(app, {
      requireRepository: () => repo,
      auth: {
        authenticate: async () => ({
          id: ownerId,
          email: "owner@example.com",
          displayName: null
        }),
        authenticateDeviceCredential: async (request) => {
          const auth = request.headers.authorization?.replace(
            /^Koed-Device /,
            ""
          );
          const record = auth ? credentials[auth] : undefined;
          if (!record)
            throw Object.assign(new Error("Invalid device"), {
              statusCode: 401
            });
          return {
            user: {
              id: record.userId,
              email: "device@example.com",
              displayName: null
            },
            credential: {
              id: record.deviceId,
              deviceLabel: record.label,
              operationFamilies: record.families
            }
          };
        }
      },
      config,
      rateLimit: { aiClientControl: async () => undefined }
    } as unknown as ApiRouteContext);
    await app.ready();

    const instanceBody = {
      driver_id: "codex",
      display_name: "codex",
      config_identity_hash: "a".repeat(64)
    };
    const publishInstance = (authorization: string, payload = instanceBody) =>
      app.inject({
        method: "PUT",
        url: "/v1/memory/ai-client-instances/codex.default",
        headers: { authorization: `Koed-Device ${authorization}` },
        payload
      });
    const first = await publishInstance("runner-a:secret");
    const second = await publishInstance("runner-b:secret", {
      ...instanceBody,
      config_identity_hash: "b".repeat(64)
    });
    const missingFamily = await publishInstance("wrong-scope:secret");
    const spoofedDevice = await publishInstance("runner-a:secret", {
      ...instanceBody,
      source_device_credential_id: deviceB
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(missingFamily.statusCode).toBe(403);
    expect(spoofedDevice.statusCode).toBe(400);
    expect(instances.size).toBe(2);
    expect(
      [...instances.values()].filter(
        (instance) => instance.ownerUserId === ownerId
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceDeviceCredentialId: deviceA,
          sourceDeviceLabel: "Runner A"
        }),
        expect.objectContaining({
          sourceDeviceCredentialId: deviceB,
          sourceDeviceLabel: "Runner B"
        })
      ])
    );

    const disableInstance = await app.inject({
      method: "PATCH",
      url: `/v1/memory/ai-client-instances/runner.${deviceA.replaceAll("-", "")}/enabled`,
      headers: { authorization: "Bearer ignored" },
      payload: { enabled: false }
    });
    expect(disableInstance.statusCode).toBe(200);
    expect(disableInstance.json().instance).toMatchObject({ enabled: false });
    const missingInstance = await app.inject({
      method: "PATCH",
      url: "/v1/memory/ai-client-instances/codex.unknown/enabled",
      headers: { authorization: "Bearer ignored" },
      payload: { enabled: false }
    });
    expect(missingInstance.statusCode).toBe(404);
    const invalidToggle = await app.inject({
      method: "PATCH",
      url: `/v1/memory/ai-client-instances/runner.${deviceA.replaceAll("-", "")}/enabled`,
      headers: { authorization: "Bearer ignored" },
      payload: { enabled: "false", source_device_credential_id: deviceB }
    });
    expect(invalidToggle.statusCode).toBe(400);

    const changedIdentity = "d".repeat(64);
    expect(
      (
        await publishInstance("runner-a:secret", {
          ...instanceBody,
          config_identity_hash: changedIdentity
        })
      ).statusCode
    ).toBe(200);
    const changedSnapshot = await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      headers: { authorization: "Koed-Device runner-a:secret" },
      payload: {
        installation_identity_hash: changedIdentity,
        authentication_state: "authenticated",
        health_state: "healthy",
        models: [],
        capabilities: { descriptors: {} },
        observed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString()
      }
    });
    expect(changedSnapshot.statusCode).toBe(200);
    const boundInstance = instances.get(
      `${ownerId}:${"codex.default"}:${deviceA}`
    );
    expect(boundInstance?.enabled).toBe(false);
    const boundSnapshot = snapshots.find(
      (snapshot) => snapshot.sourceDeviceCredentialId === deviceA
    );
    expect(boundInstance?.configIdentityHash).toBe(
      boundSnapshot?.installationIdentityHash
    );
    expect(boundInstance?.configIdentityHash).not.toBe(changedIdentity);

    const snapshotBody = {
      installation_identity_hash: "c".repeat(64),
      authentication_state: "authenticated",
      health_state: "healthy",
      models: [],
      capabilities: { descriptors: {} },
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300_000).toISOString()
    };
    const snapshot = await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      headers: { authorization: "Koed-Device runner-b:secret" },
      payload: snapshotBody
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerUserId: ownerId,
          sourceDeviceCredentialId: deviceB
        })
      ])
    );
    const unregisteredDeviceSnapshot = await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      headers: { authorization: "Koed-Device runner-c:secret" },
      payload: snapshotBody
    });
    const crossOwnerSnapshot = await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      headers: { authorization: "Koed-Device other-owner:secret" },
      payload: snapshotBody
    });
    expect(unregisteredDeviceSnapshot.statusCode).toBe(409);
    expect(crossOwnerSnapshot.statusCode).toBe(409);

    const ordinaryRemoteWrite = await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/codex.web",
      headers: { authorization: "Bearer ignored" },
      payload: instanceBody
    });
    expect(ordinaryRemoteWrite.statusCode).toBe(403);
    config.deploymentProfile = "developer";
    const ordinaryLocalWrite = await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/codex.local",
      headers: { authorization: "Bearer ignored" },
      payload: instanceBody
    });
    expect(ordinaryLocalWrite.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/memory/ai-client-instances",
      headers: { authorization: "Bearer ignored" }
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(deviceA);
    expect(JSON.stringify(listed.json())).not.toContain(deviceB);
    const settingsListed = await app.inject({
      method: "GET",
      url: "/v1/memory/local-agent-settings",
      headers: { authorization: "Bearer ignored" }
    });
    expect(settingsListed.statusCode).toBe(200);
    expect(JSON.stringify(settingsListed.json())).not.toContain(deviceA);
    expect(JSON.stringify(settingsListed.json())).not.toContain(deviceB);
    expect(settingsListed.json().capabilitySnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostedInstanceId: expect.any(String) })
      ])
    );
    await app.close();
  });
});
