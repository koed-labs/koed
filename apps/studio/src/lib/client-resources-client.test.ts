import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverClientResources,
  loadClientResourceTargets
} from "./client-resources-client";
import { studioAuthenticatedRequest } from "./personal-agents-client";

vi.mock("./personal-agents-client", () => ({
  studioAuthenticatedRequest: vi.fn()
}));
const request = vi.mocked(studioAuthenticatedRequest);
const timestamp = new Date().toISOString();
const catalog = {
  version: 1,
  provider: "codex",
  aiClientInstanceId: "codex",
  hostedInstanceId: "computer-a-codex",
  computerLabel: "Computer A",
  projectId: null,
  observedAt: timestamp,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  resources: [
    {
      resourceId: `res_${"a".repeat(64)}`,
      kind: "skill",
      name: "review",
      status: "ready",
      source: "user",
      invocation: "native_skill"
    }
  ]
};
const operation = (values: Record<string, unknown> = {}) => ({
  operationId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  hostedInstanceId: catalog.hostedInstanceId,
  projectId: null,
  state: "completed",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  catalog,
  ...values
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("native AI Client resources", () => {
  it("preserves distinct computer identities for the same native Client ID", async () => {
    request.mockResolvedValue({
      instances: [
        {
          instanceId: "codex",
          hostedInstanceId: "computer-a-codex",
          driverId: "codex",
          enabled: true,
          sourceDeviceLabel: "Computer A"
        },
        {
          instanceId: "codex",
          hostedInstanceId: "computer-b-codex",
          driverId: "codex",
          enabled: true,
          sourceDeviceLabel: "Computer B"
        }
      ],
      capabilitySnapshots: [
        {
          hostedInstanceId: "computer-a-codex",
          authenticationState: "authenticated"
        }
      ]
    });
    const targets = await loadClientResourceTargets();
    expect(targets.map((value) => value.hostedInstanceId)).toEqual([
      "computer-a-codex",
      "computer-b-codex"
    ]);
    expect(targets.map((value) => value.computerLabel)).toEqual([
      "Computer A",
      "Computer B"
    ]);
    expect(targets[1].authenticationState).toBe("unknown");
  });
  it("discovers native Skills without creating a Job or injecting their text", async () => {
    request.mockResolvedValue(operation());
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).resolves.toEqual(catalog);
    expect(request).toHaveBeenCalledTimes(1);
    const [path, options] = request.mock.calls[0];
    expect(path).toBe("/studio-api/ai-client-resources/discover");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      hostedInstanceId: catalog.hostedInstanceId,
      projectId: null
    });
    expect(String(options?.body)).not.toContain("review");
  });
  it("rejects a catalog from another Client or Project and expired catalogs", async () => {
    request.mockResolvedValue(
      operation({
        hostedInstanceId: "computer-b-codex",
        catalog: { ...catalog, hostedInstanceId: "computer-b-codex" }
      })
    );
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).rejects.toThrow("configuration changed");
    request.mockResolvedValue(
      operation({
        projectId: "different",
        catalog: { ...catalog, projectId: "different" }
      })
    );
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).rejects.toThrow("configuration changed");
    request.mockResolvedValue(
      operation({
        catalog: {
          ...catalog,
          observedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString()
        }
      })
    );
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).rejects.toThrow("configuration changed");
  });
  it("does not expose a provider's configuration bytes or filesystem paths", async () => {
    request.mockResolvedValue(
      operation({
        catalog: {
          ...catalog,
          resources: [{ ...catalog.resources[0], path: "/private/skill.md" }]
        }
      })
    );
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).rejects.toThrow();
  });
});
