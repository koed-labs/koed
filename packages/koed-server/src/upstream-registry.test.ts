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
  beginUpstreamDisconnectCleanup,
  completeUpstreamDisconnectCleanup
} from "./upstream-disconnect-cleanup.js";
import {
  collectUpstreamRegistryStatus,
  getActiveUpstreamBackend,
  listUpstreamBackends,
  refreshUpstreamBackendCapabilities,
  registerUpstreamBackend,
  removeUpstreamBackend,
  setActiveUpstreamBackend,
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
        personalCollaboration: "disabled",
        teamWorkspaceRead: "disabled",
        shareGrantManagement: "disabled",
        captureWrites: "disabled",
        sync: "disabled",
        managedExecution: "disabled",
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
          capabilitySchemaVersion: 4,
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
        schemaVersion: 4,
        profile: "team_self_hosted"
      }
    });
  });

  it("preserves backend identity and trust when reconnecting by canonical URL", async () => {
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
          capabilitySchemaVersion: 4,
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
    setActiveUpstreamBackend(paths, "team-vps");

    registerUpstreamBackend(paths, {
      url: "https://team.example.test",
      displayName: "Team Backend",
      profile: "team-self-hosted"
    });

    expect(getActiveUpstreamBackend(paths)).toMatchObject({
      id: "team-vps",
      displayName: "Team Backend",
      credential: { status: "configured", reference: "keychain://team-vps" },
      routePolicy: { teamWorkspaceRead: "enabled", sync: "enabled" },
      capabilities: {
        state: "validated",
        schemaVersion: 4,
        profile: "team_self_hosted"
      }
    });
    expect(listUpstreamBackends(paths).backends).toHaveLength(1);
  });

  it("moves active selection with an explicit backend id rename", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "old-team-vps",
      url: "https://team.example.test",
      profile: "team-self-hosted"
    });
    setActiveUpstreamBackend(paths, "old-team-vps");

    const renamed = registerUpstreamBackend(paths, {
      id: "new-team-vps",
      url: "https://team.example.test",
      profile: "team-self-hosted"
    });

    expect(renamed).toMatchObject({
      ok: true,
      state: "updated",
      backend: {
        id: "new-team-vps",
        credential: { status: "not_configured" }
      }
    });
    expect(getActiveUpstreamBackend(paths)).toMatchObject({
      id: "new-team-vps"
    });
    expect(listUpstreamBackends(paths).backends).toHaveLength(1);
  });

  it("rejects a backend update that would duplicate another normalized URL", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "primary-team",
      url: "https://primary.example.test",
      profile: "team-self-hosted"
    });
    registerUpstreamBackend(paths, {
      id: "secondary-team",
      url: "https://secondary.example.test",
      profile: "team-self-hosted"
    });
    setActiveUpstreamBackend(paths, "primary-team");
    const before = readFileSync(paths.upstreamBackendsPath, "utf8");

    expect(() =>
      registerUpstreamBackend(paths, {
        id: "primary-team",
        url: "https://secondary.example.test/",
        profile: "team-self-hosted"
      })
    ).toThrow("Upstream URL is already registered as secondary-team.");
    expect(readFileSync(paths.upstreamBackendsPath, "utf8")).toBe(before);
    expect(getActiveUpstreamBackend(paths)?.id).toBe("primary-team");
    expect(listUpstreamBackends(paths).backends).toHaveLength(2);
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
          capabilitySchemaVersion: 4,
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
    expect(() =>
      registerUpstreamBackend(paths, {
        url: "http://team.example.test",
        id: "remote-http"
      })
    ).toThrow("must use HTTPS unless it targets localhost");
  });

  it.each([
    "http://localhost:3300",
    "http://127.0.0.1:3300",
    "http://[::1]:3300"
  ])("allows exact loopback HTTP upstream %s", (url) => {
    const paths = tempPaths();
    const result = registerUpstreamBackend(paths, {
      url,
      id: "local-dev"
    });

    expect(result).toMatchObject({
      ok: true,
      state: "registered",
      backend: { id: "local-dev" }
    });
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
      fetch: async (url, init) => {
        expect(String(url)).toBe(
          "https://cloud.example.test/koed/v1/capabilities"
        );
        expect(init?.redirect).toBe("error");
        return response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 4,
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
        schemaVersion: 4,
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

  it.each([2, 3])(
    "continues to accept capability schema %i during rollout",
    async (schemaVersion) => {
      const paths = tempPaths();
      registerUpstreamBackend(paths, {
        id: `v${schemaVersion}-cloud`,
        url: `https://v${schemaVersion}.example.test`,
        profile: "koed-managed-cloud"
      });

      const result = await refreshUpstreamBackendCapabilities(
        paths,
        `v${schemaVersion}-cloud`,
        {
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          fetch: async () =>
            response(true, 200, {
              product: "koed",
              apiVersion: "v1",
              capabilitySchemaVersion: schemaVersion,
              deployment: { profile: "koed_managed_cloud" }
            })
        }
      );

      expect(result.ok).toBe(true);
      expect(result.backend?.capabilities).toMatchObject({
        state: "validated",
        schemaVersion,
        profile: "koed_managed_cloud"
      });
    }
  );

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

  it("does not let a late capability refresh overwrite disconnect state", async () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test"
    });
    setActiveUpstreamBackend(paths, "team-vps");
    updateUpstreamBackendRoutePolicy(paths, "team-vps", {
      sync: "enabled"
    });
    let release!: () => void;
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const pendingResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = refreshUpstreamBackendCapabilities(paths, "team-vps", {
      now: () => new Date("2026-01-01T00:02:00.000Z"),
      fetch: async () => {
        requested();
        await pendingResponse;
        return response(true, 200, {
          product: "koed",
          apiVersion: "v1",
          capabilitySchemaVersion: 4,
          deployment: { profile: "team_self_hosted" }
        });
      }
    });
    await requestStarted;

    setActiveUpstreamBackend(paths, null, {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });
    updateUpstreamBackendRoutePolicy(
      paths,
      "team-vps",
      { sync: "disabled" },
      { now: () => new Date("2026-01-01T00:01:00.000Z") }
    );
    release();

    await expect(refresh).resolves.toMatchObject({
      ok: false,
      state: "failed"
    });
    expect(getActiveUpstreamBackend(paths)).toBeNull();
    expect(listUpstreamBackends(paths).backends?.[0]).toMatchObject({
      routePolicy: { sync: "disabled" },
      capabilities: { state: "not_checked" }
    });
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

  it("fails closed when persisted backends duplicate an id or normalized URL", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "first-team",
      url: "https://first.example.test"
    });
    registerUpstreamBackend(paths, {
      id: "second-team",
      url: "https://second.example.test"
    });
    const registry = JSON.parse(
      readFileSync(paths.upstreamBackendsPath, "utf8")
    ) as UpstreamBackendRegistry;
    registry.backends[1]!.baseUrl = "https://first.example.test/";
    writeFileSync(paths.upstreamBackendsPath, JSON.stringify(registry));

    expect(() => listUpstreamBackends(paths)).toThrow(
      "Upstream backend registry is malformed"
    );
    expect(collectUpstreamRegistryStatus(paths)).toMatchObject({
      registered: 0,
      parseError: "Upstream backend registry is malformed.",
      backends: []
    });
  });

  it("fails closed for an unsupported registry schema or dangling active backend", () => {
    const paths = tempPaths();
    mkdirSync(resolve(paths.upstreamBackendsPath, ".."), { recursive: true });
    writeFileSync(
      paths.upstreamBackendsPath,
      JSON.stringify({ schemaVersion: 1, updatedAt: "now", backends: [] })
    );
    expect(() => listUpstreamBackends(paths)).toThrow(
      "Upstream backend registry is malformed"
    );

    writeFileSync(
      paths.upstreamBackendsPath,
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: "now",
        activeBackendId: "missing",
        backends: []
      })
    );
    expect(() => listUpstreamBackends(paths)).toThrow(
      "Upstream backend registry is malformed"
    );
  });

  it("persists one explicit active backend and clears it when removed", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "first",
      url: "https://first.example.test"
    });
    registerUpstreamBackend(paths, {
      id: "second",
      url: "https://second.example.test"
    });

    expect(getActiveUpstreamBackend(paths)).toBeNull();
    expect(setActiveUpstreamBackend(paths, "second").ok).toBe(true);
    expect(getActiveUpstreamBackend(paths)?.id).toBe("second");
    expect(setActiveUpstreamBackend(paths, "missing").ok).toBe(false);
    expect(getActiveUpstreamBackend(paths)?.id).toBe("second");

    removeUpstreamBackend(paths, "second");
    expect(getActiveUpstreamBackend(paths)).toBeNull();
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

  it("refuses to remove a backend while disconnect cleanup is durable", () => {
    const paths = tempPaths();
    registerUpstreamBackend(paths, {
      id: "team-vps",
      url: "https://team.example.test"
    });
    beginUpstreamDisconnectCleanup(paths, "team-vps");

    expect(removeUpstreamBackend(paths, "team-vps")).toMatchObject({
      ok: false,
      state: "failed"
    });
    expect(listUpstreamBackends(paths).backends).toHaveLength(1);

    completeUpstreamDisconnectCleanup(paths, "team-vps");
    expect(removeUpstreamBackend(paths, "team-vps").state).toBe("removed");
  });
});
