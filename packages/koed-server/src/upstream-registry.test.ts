import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  collectUpstreamRegistryStatus,
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  removeUpstreamBackend,
  updateUpstreamBackendRoutePolicy,
  type UpstreamBackendRegistry
} from "./upstream-registry.js";

const temps: string[] = [];

const tempPaths = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-upstreams-"));
  temps.push(root);
  return resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
};

const response = (ok: boolean, status: number, body: unknown): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response;

const firstBackend = (registry: UpstreamBackendRegistry) => {
  const backend = registry.backends[0];
  if (!backend) {
    throw new Error("Expected upstream registry fixture to contain a backend");
  }
  return backend;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("upstream backend registry", () => {
  it("registers and updates upstream backends idempotently without enabling routes", () => {
    const paths = tempPaths();
    const now = () => new Date("2026-01-01T00:00:00.000Z");

    const created = registerUpstreamBackend(
      paths,
      {
        id: "team-vps",
        url: "https://team.example.test/",
        displayName: "Team VPS",
        profile: "private-vps"
      },
      { now }
    );
    const updated = registerUpstreamBackend(
      paths,
      {
        id: "team-vps",
        url: "https://team.example.test",
        displayName: "Team VPS Updated",
        profile: "team-self-hosted"
      },
      { now }
    );
    const listed = listUpstreamBackends(paths);

    expect(created.state).toBe("registered");
    expect(updated.state).toBe("updated");
    expect(listed.backends).toHaveLength(1);
    expect(listed.backends?.[0]).toMatchObject({
      id: "team-vps",
      displayName: "Team VPS Updated",
      baseUrl: "https://team.example.test",
      profile: "team_self_hosted",
      credential: { status: "not_configured" },
      routePolicy: {
        personalMemoryRead: "disabled",
        teamWorkspaceRead: "disabled",
        shareGrantManagement: "disabled",
        captureWrites: "disabled",
        sync: "disabled",
        admin: "disabled"
      },
      capabilities: {
        state: "not_checked",
        schemaVersion: null
      }
    });
  });

  it("updates route policy explicitly without changing other operation families", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test/",
      displayName: "Team VPS",
      profile: "private-vps"
    });

    const result = updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      shareGrantManagement: "enabled"
    });
    const listed = listUpstreamBackends(paths);

    expect(result).toMatchObject({
      ok: true,
      state: "updated",
      backend: {
        id: "team-vps",
        routePolicy: {
          personalMemoryRead: "disabled",
          teamWorkspaceRead: "enabled",
          shareGrantManagement: "enabled",
          captureWrites: "disabled",
          sync: "disabled",
          admin: "disabled"
        }
      }
    });
    expect(listed.backends?.[0]?.routePolicy).toMatchObject({
      teamWorkspaceRead: "enabled",
      shareGrantManagement: "enabled",
      captureWrites: "disabled"
    });
  });

  it("preserves cached trust state only for display-only updates", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test/",
      displayName: "Team VPS",
      profile: "team-self-hosted"
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled"
    });
    await refreshUpstreamBackendCapabilities(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetch: async () =>
        response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 3,
          releaseVersion: "0.2.0",
          deployment: { profile: "team_self_hosted" }
        })
    });
    const trustedRegistry = JSON.parse(
      readFileSync(paths.upstreamBackendsPath, "utf8")
    ) as UpstreamBackendRegistry;
    firstBackend(trustedRegistry).credential = {
      status: "configured",
      reference: "keychain://team-vps"
    };
    writeFileSync(
      paths.upstreamBackendsPath,
      `${JSON.stringify(trustedRegistry, null, 2)}\n`
    );

    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test",
      displayName: "Renamed Team VPS",
      profile: "team-self-hosted"
    });
    const preserved = listUpstreamBackends(paths).backends?.[0];

    expect(preserved).toMatchObject({
      displayName: "Renamed Team VPS",
      credential: { status: "configured", reference: "keychain://team-vps" },
      routePolicy: { teamWorkspaceRead: "enabled" },
      capabilities: {
        state: "validated",
        schemaVersion: 3,
        profile: "team_self_hosted"
      }
    });
  });

  it("resets credentials, capabilities, and routes when the upstream trust boundary changes", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test/",
      displayName: "Team VPS",
      profile: "team-self-hosted"
    });
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      teamWorkspaceRead: "enabled",
      sync: "enabled"
    });
    await refreshUpstreamBackendCapabilities(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetch: async () =>
        response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 3,
          releaseVersion: "0.2.0",
          deployment: { profile: "team_self_hosted" }
        })
    });
    const trustedRegistry = JSON.parse(
      readFileSync(paths.upstreamBackendsPath, "utf8")
    ) as UpstreamBackendRegistry;
    firstBackend(trustedRegistry).credential = {
      status: "configured",
      reference: "keychain://team-vps"
    };
    writeFileSync(
      paths.upstreamBackendsPath,
      `${JSON.stringify(trustedRegistry, null, 2)}\n`
    );

    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://replacement.example.test",
      displayName: "Replacement Team VPS",
      profile: "private-vps"
    });
    const reset = listUpstreamBackends(paths).backends?.[0];

    expect(reset).toMatchObject({
      id: "team-vps",
      displayName: "Replacement Team VPS",
      baseUrl: "https://replacement.example.test",
      profile: "private_vps",
      credential: { status: "not_configured" },
      routePolicy: {
        personalMemoryRead: "disabled",
        teamWorkspaceRead: "disabled",
        shareGrantManagement: "disabled",
        captureWrites: "disabled",
        sync: "disabled",
        admin: "disabled"
      },
      capabilities: {
        state: "not_checked",
        schemaVersion: null,
        profile: null
      }
    });
  });

  it("rejects upstream URLs that could smuggle credentials or route data", () => {
    const paths = tempPaths();

    expect(() =>
      registerUpstreamBackend(paths, {
        url: "https://token@example.test",
        id: "bad"
      })
    ).toThrow("must not include credentials");
    expect(() =>
      registerUpstreamBackend(paths, {
        url: "https://example.test?token=secret",
        id: "bad"
      })
    ).toThrow("must not include query strings");
    expect(() =>
      registerUpstreamBackend(paths, { url: "file:///tmp/koed", id: "bad" })
    ).toThrow("must use http or https");
  });

  it("refreshes and stores a sanitized capability cache", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "cloud",
      url: "https://cloud.example.test/koed",
      profile: "koed-managed-cloud"
    });

    const result = await refreshUpstreamBackendCapabilities(paths, "cloud", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetch: async (url) => {
        expect(String(url)).toBe(
          "https://cloud.example.test/koed/v1/capabilities"
        );
        return response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 3,
          releaseVersion: "0.2.0",
          audience: "public",
          deployment: {
            profile: "koed_managed_cloud",
            managedBy: "koed",
            distribution: "managed_service",
            productBoundary: "koed-server"
          },
          runtime: { localEdge: false, remoteUpstreams: "unavailable" },
          auth: {
            providers: ["local", "workos"],
            workosClientSecret: "client-secret-value",
            nested: {
              apiKey: "api-key-value",
              cookie: "session-cookie-value"
            }
          },
          capabilities: {
            "auth.workos": {
              availability: "partial",
              description: "WorkOS mapping",
              token: "capability-token-value"
            }
          },
          notes: ["not persisted"]
        });
      }
    });

    const raw = readFileSync(paths.upstreamBackendsPath, "utf8");
    expect(result.ok).toBe(true);
    expect(result.backend).toMatchObject({
      id: "cloud",
      profile: "koed_managed_cloud",
      capabilities: {
        state: "validated",
        checkedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:15:00.000Z",
        schemaVersion: 3,
        profile: "koed_managed_cloud",
        releaseVersion: "0.2.0"
      }
    });
    expect(raw).not.toContain("notes");
    expect(raw).not.toContain("client-secret-value");
    expect(raw).not.toContain("api-key-value");
    expect(raw).not.toContain("session-cookie-value");
    expect(raw).not.toContain("capability-token-value");
    expect(raw).toContain("[redacted]");
  });

  it("continues to accept the previous capability schema during rollout", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "v2-cloud",
      url: "https://v2.example.test",
      profile: "koed-managed-cloud"
    });

    const result = await refreshUpstreamBackendCapabilities(paths, "v2-cloud", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetch: async () =>
        response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 2,
          deployment: { profile: "koed_managed_cloud" }
        })
    });

    expect(result.ok).toBe(true);
    expect(result.backend?.capabilities).toMatchObject({
      state: "validated",
      schemaVersion: 2,
      profile: "koed_managed_cloud"
    });
  });

  it("records failed refreshes without deleting the backend", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "broken",
      url: "https://broken.example.test"
    });

    const result = await refreshUpstreamBackendCapabilities(paths, "broken", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      fetch: async () => response(false, 503, { error: "loading" })
    });

    expect(result.ok).toBe(false);
    expect(result.backend).toMatchObject({
      id: "broken",
      capabilities: {
        state: "failed",
        checkedAt: "2026-01-01T00:00:00.000Z",
        failureCategory: "http"
      }
    });
    expect(listUpstreamBackends(paths).backends).toHaveLength(1);
  });

  it("fails closed when the upstream registry file is malformed", () => {
    const paths = tempPaths();
    mkdirSync(resolve(paths.upstreamBackendsPath, ".."), { recursive: true });
    writeFileSync(paths.upstreamBackendsPath, "{not-json");

    expect(() => listUpstreamBackends(paths)).toThrow(
      "Upstream backend registry is malformed"
    );
    expect(() =>
      registerUpstreamBackend(paths, {
        id: "cloud",
        url: "https://cloud.example.test"
      })
    ).toThrow("Upstream backend registry is malformed");
    expect(collectUpstreamRegistryStatus(paths)).toMatchObject({
      registered: 0,
      parseError: "Upstream backend registry is malformed.",
      backends: []
    });
  });

  it("summarizes stale, failed, and unchecked upstreams for diagnostics", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, { id: "unchecked", url: "https://a.test" });
    registerUpstreamBackend(paths, { id: "valid", url: "https://b.test" });
    registerUpstreamBackend(paths, { id: "failed", url: "https://c.test" });

    const registry = JSON.parse(
      readFileSync(paths.upstreamBackendsPath, "utf8")
    ) as {
      backends: Array<{
        id: string;
        capabilities: Record<string, unknown>;
      }>;
    };
    for (const backend of registry.backends) {
      if (backend.id === "valid") {
        backend.capabilities = {
          state: "validated",
          checkedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:01:00.000Z",
          schemaVersion: 2,
          profile: "private_vps",
          releaseVersion: "0.2.0"
        };
      }
      if (backend.id === "failed") {
        backend.capabilities = {
          state: "failed",
          checkedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          schemaVersion: null,
          profile: null,
          releaseVersion: null,
          failureCategory: "network"
        };
      }
    }
    writeFileSync(paths.upstreamBackendsPath, JSON.stringify(registry));

    const status = collectUpstreamRegistryStatus(paths, {
      now: () => new Date("2026-01-01T00:02:00.000Z")
    });

    expect(status).toMatchObject({
      registered: 3,
      validated: 0,
      stale: 1,
      failed: 1,
      notChecked: 1
    });
    expect(JSON.stringify(status)).not.toContain("payload");
  });

  it("removes upstreams idempotently", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test"
    });

    expect(removeUpstreamBackend(paths, "team-vps").state).toBe("removed");
    expect(removeUpstreamBackend(paths, "team-vps").state).toBe("missing");
    expect(listUpstreamBackends(paths).backends).toHaveLength(0);
  });
});
