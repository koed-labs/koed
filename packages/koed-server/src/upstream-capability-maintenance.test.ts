import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecureUpstreamFetch } from "@koed/shared/secure-upstream-fetch";
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

const createDelayedDnsFetch = (fetcher: typeof fetch) => {
  let startSlowLookup!: () => void;
  let releaseSlowLookup!: () => void;
  const slowLookupStarted = new Promise<void>((resolve) => {
    startSlowLookup = resolve;
  });
  const pendingLookup = new Promise<{ address: string; family: 4 | 6 }[]>(
    (resolve) => {
      releaseSlowLookup = () =>
        resolve([{ address: "203.0.114.8", family: 4 }]);
    }
  );
  const secureFetch = createSecureUpstreamFetch({
    dependencies: {
      lookup: (hostname) => {
        if (hostname === "a-slow.example.test") {
          startSlowLookup();
          return pendingLookup;
        }
        return Promise.resolve([{ address: "203.0.114.9", family: 4 }]);
      },
      fetch: fetcher
    }
  });
  return { secureFetch, slowLookupStarted, releaseSlowLookup };
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
  it("refreshes healthy upstreams after a timed-out DNS lookup", async () => {
    const paths = pathsForTest();
    add(paths, "a-slow");
    add(paths, "b-healthy");
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementationOnce(() => timeoutController.signal);
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify(capabilities));
    });
    const { secureFetch, slowLookupStarted, releaseSlowLookup } =
      createDelayedDnsFetch(fetcher);
    let resolveHealthyRefresh!: () => void;
    const healthyRefresh = new Promise<void>((resolve) => {
      resolveHealthyRefresh = resolve;
    });
    const refresh = vi.fn<typeof refreshUpstreamBackendCapabilities>(
      async (p, id, deps) => {
        const result = await refreshUpstreamBackendCapabilities(p, id, {
          ...deps,
          fetch: secureFetch
        });
        if (id === "b-healthy" && result.ok) resolveHealthyRefresh();
        return result;
      }
    );
    const stop = maintainUpstreamCapabilities(paths, { refresh });
    stops.push(stop);

    try {
      await slowLookupStarted;
      timeoutController.abort(new DOMException("deadline", "TimeoutError"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(refresh.mock.calls.map(([, id]) => id)).toEqual([
        "a-slow",
        "b-healthy"
      ]);
      await healthyRefresh;
      const backends = listUpstreamBackends(paths).backends ?? [];
      expect(
        backends.find((backend) => backend.id === "a-slow")?.capabilities.state
      ).toBe("failed");
      expect(
        backends.find((backend) => backend.id === "b-healthy")?.capabilities
          .state
      ).toBe("validated");
    } finally {
      stop();
      releaseSlowLookup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await secureFetch.close();
      timeoutSpy.mockRestore();
    }
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
