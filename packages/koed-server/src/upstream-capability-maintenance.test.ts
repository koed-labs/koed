import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import { maintainUpstreamCapabilities } from "./upstream-capability-maintenance.js";
import {
  listUpstreamBackends,
  registerUpstreamBackend,
  updateUpstreamBackendRoutePolicy,
  updateUpstreamBackendCredential,
  refreshUpstreamBackendCapabilities
} from "./upstream-registry.js";

const roots: string[] = [];
const stops: Array<() => void> = [];
const pathsForTest = () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-capability-maintenance-"));
  roots.push(root);
  return resolveKoedServerPaths({ KOED_HOME: root, KOED_REPO_ROOT: root });
};
const capabilities = {
  product: "koed",
  apiVersion: "v1",
  capabilitySchemaVersion: 4,
  releaseVersion: "0.2.0",
  audience: "public",
  deployment: {
    profile: "team_self_hosted",
    managedBy: "team_operator",
    distribution: "source_available",
    productBoundary: "koed-server"
  },
  runtime: { localEdge: false, remoteUpstreams: "unavailable" },
  auth: { providers: ["workos"] },
  capabilities: {}
};
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const add = (paths: ReturnType<typeof pathsForTest>, id = "team") => {
  registerUpstreamBackend(paths, {
    id,
    url: `https://${id}.example.test`,
    profile: "private-vps"
  });
  updateUpstreamBackendRoutePolicy(paths, id, { teamWorkspaceRead: "enabled" });
};

describe("Server-owned upstream capability maintenance", () => {
  it("keeps Team capabilities fresh beyond expiry without a Desktop broker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const paths = pathsForTest();
    add(paths);
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(capabilities))
    );
    const refresh = vi.fn<typeof refreshUpstreamBackendCapabilities>(
      (p, id, deps) =>
        refreshUpstreamBackendCapabilities(p, id, { ...deps, fetch: fetcher })
    );
    stops.push(maintainUpstreamCapabilities(paths, { refresh }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    const cache = listUpstreamBackends(paths).backends?.[0]?.capabilities;
    expect(cache?.state).toBe("validated");
    expect(Date.parse(cache?.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });
  it("retries failed validation and picks up upstreams added after startup", async () => {
    vi.useFakeTimers();
    const paths = pathsForTest();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(capabilities), { status: 503 })
    );
    const refresh = vi.fn<typeof refreshUpstreamBackendCapabilities>(
      (p, id, deps) =>
        refreshUpstreamBackendCapabilities(p, id, { ...deps, fetch: fetcher })
    );
    stops.push(maintainUpstreamCapabilities(paths, { refresh }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    add(paths);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listUpstreamBackends(paths).backends?.[0]?.capabilities.state).toBe(
      "failed"
    );
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify(capabilities))
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(listUpstreamBackends(paths).backends?.[0]?.capabilities.state).toBe(
      "validated"
    );
  });
  it("does not overlap checks and cancels network work on shutdown without changing the cache", async () => {
    vi.useFakeTimers();
    const paths = pathsForTest();
    add(paths);
    const before = readFileSync(paths.upstreamBackendsPath, "utf8");
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true }
          )
        )
    );
    const refresh = vi.fn<typeof refreshUpstreamBackendCapabilities>(
      (p, id, deps) =>
        refreshUpstreamBackendCapabilities(p, id, { ...deps, fetch: fetcher })
    );
    const stop = maintainUpstreamCapabilities(paths, { refresh });
    stops.push(stop);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(readFileSync(paths.upstreamBackendsPath, "utf8")).toBe(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("does not refresh revoked upstreams", async () => {
    vi.useFakeTimers();
    const paths = pathsForTest();
    add(paths);
    updateUpstreamBackendCredential(paths, "team", { status: "revoked" });
    const refresh = vi.fn();
    stops.push(maintainUpstreamCapabilities(paths, { refresh }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("leaves disabled routes untouched", async () => {
    vi.useFakeTimers();
    const paths = pathsForTest();
    registerUpstreamBackend(paths, {
      id: "disabled",
      url: "https://disabled.example.test",
      profile: "private-vps"
    });
    const refresh = vi.fn();
    stops.push(maintainUpstreamCapabilities(paths, { refresh }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
