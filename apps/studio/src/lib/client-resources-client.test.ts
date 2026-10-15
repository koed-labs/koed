import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_RESOURCE_DISCOVERY_DEADLINE_MS,
  ClientResourceDiscoveryError,
  clientResourceAvailability,
  clientResourceCanBeSelected,
  clientResourceErrorMessage,
  discoverClientResources,
  loadClientResourceTargets,
  type ClientResourceCatalog
} from "./client-resources-client";
import { studioAuthenticatedRequest } from "./personal-agents-client";

vi.mock("./personal-agents-client", () => ({
  studioAuthenticatedRequest: vi.fn()
}));
const request = vi.mocked(studioAuthenticatedRequest);
const timestamp = new Date().toISOString();
const discoveryRequestId = "22222222-2222-4222-8222-222222222222";
const catalog: ClientResourceCatalog = {
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
  requestId: discoveryRequestId,
  hostedInstanceId: catalog.hostedInstanceId,
  projectId: null,
  state: "completed",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  catalog,
  ...values
});
beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(discoveryRequestId);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    expect(targets[1].enabled).toBeNull();
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
  it("keeps native availability separate from verified managed invocation", () => {
    const [legacySkill] = catalog.resources;
    expect(clientResourceAvailability(legacySkill)).toBe("available");
    expect(clientResourceCanBeSelected(legacySkill)).toBe(false);
    expect(
      clientResourceAvailability({
        ...legacySkill,
        status: "unavailable",
        availability: "unknown",
        executionSupport: "koed_managed"
      })
    ).toBe("unknown");
    expect(
      clientResourceCanBeSelected({
        ...legacySkill,
        availability: "available",
        executionSupport: "koed_managed"
      })
    ).toBe(true);
    expect(
      clientResourceCanBeSelected({
        ...legacySkill,
        availability: "available",
        executionSupport: "inventory_only"
      })
    ).toBe(false);
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
    ).rejects.toThrow("changed during discovery");
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
    ).rejects.toThrow("changed during discovery");
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
  it("rejects operations from a different discovery request even when scope matches", async () => {
    request.mockResolvedValue(
      operation({ requestId: "33333333-3333-4333-8333-333333333333" })
    );
    await expect(
      discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      })
    ).rejects.toMatchObject({
      code: "AiClientResourceTargetScopeMismatch"
    });
  });
  it("preserves a validated actionable error code", async () => {
    request.mockResolvedValue(
      operation({
        state: "failed",
        catalog: undefined,
        errorCode: "AiClientCodexAuthenticationRequired"
      })
    );
    let failure: unknown;
    try {
      await discoverClientResources({
        hostedInstanceId: catalog.hostedInstanceId,
        projectId: null
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ClientResourceDiscoveryError);
    expect(failure).toMatchObject({
      code: "AiClientCodexAuthenticationRequired"
    });
    expect(clientResourceErrorMessage(failure)).toContain(
      "Sign in through Codex"
    );
    expect(clientResourceErrorMessage(failure)).not.toContain(
      "AiClientCodexAuthenticationRequired"
    );
  });
  it("rejects canceled requests without accepting a late catalog", async () => {
    const controller = new AbortController();
    request.mockImplementation(() => new Promise(() => undefined));
    const pending = discoverClientResources(
      { hostedInstanceId: catalog.hostedInstanceId, projectId: null },
      controller.signal
    );
    controller.abort(new DOMException("Request canceled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not start discovery when its scope was already canceled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Request canceled", "AbortError"));
    await expect(
      discoverClientResources(
        { hostedInstanceId: catalog.hostedInstanceId, projectId: null },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
  it("enforces the bounded 60-second discovery deadline", async () => {
    vi.useFakeTimers();
    request.mockImplementation(() => new Promise(() => undefined));
    const pending = discoverClientResources({
      hostedInstanceId: catalog.hostedInstanceId,
      projectId: null
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "AiClientResourceDiscoveryTimedOut"
    });
    await vi.advanceTimersByTimeAsync(CLIENT_RESOURCE_DISCOVERY_DEADLINE_MS);
    await rejected;
  });
});
