import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectKoedServerStatus, fetchHistoricalActivity } from "./status.js";

describe("historical activity deadline", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["fetch", "body"])("omits activity when %s stalls", async (stall) => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const fetcher = vi.fn(() =>
      stall === "fetch"
        ? never
        : Promise.resolve({
            ok: true,
            json: () => never
          } as unknown as Response)
    ) as unknown as typeof fetch;
    const activity = fetchHistoricalActivity({
      koedHome: "/fixture",
      apiUrl: "http://localhost:43300",
      token: "test",
      fetcher,
      readFile: () => JSON.stringify({ selectionFrozen: true, selections: [] })
    });
    let settled = false;
    void activity.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true);
    expect(await activity).toBeNull();
  });

  it.each(["list fetch", "list body", "detail body"])(
    "aborts underlying %s through full status path",
    async (stall) => {
      const root = mkdtempSync(resolve(tmpdir(), "koed-activity-timeout-"));
      let aborted = false;
      let stalledRequests = 0;
      try {
        mkdirSync(resolve(root, "run"), { recursive: true });
        mkdirSync(resolve(root, "state"), { recursive: true });
        writeFileSync(
          resolve(root, "run/koed-server.json"),
          JSON.stringify({
            pid: 42,
            startedAt: "2026-01-01T00:00:00.000Z",
            repoRoot: root,
            apiUrl: "http://127.0.0.1:43300",
            runtimeMode: "external",
            dependencyMode: "external",
            automaticPorts: false,
            services: ["api", "worker"],
            processes: { api: 43, worker: 44 }
          })
        );
        writeFileSync(
          resolve(root, "state/codex-historical-ingestion.json"),
          JSON.stringify({ selectionFrozen: true, selections: [] })
        );
        const fetcher: typeof fetch = async (input, init) => {
          const url = String(input);
          if (!url.includes("/v1/historical-imports")) {
            return new Response(JSON.stringify({ status: "ok", checks: [] }), {
              status: 200
            });
          }
          const detail = url.includes("/v1/historical-imports/");
          if (stall === "detail body" && !detail) {
            return new Response(JSON.stringify({ runs: [{ id: "one" }] }), {
              status: 200
            });
          }
          stalledRequests++;
          const waitForAbort = () =>
            new Promise<never>((_resolve, reject) => {
              const onAbort = () => {
                aborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              };
              if (init?.signal?.aborted) onAbort();
              else
                init?.signal?.addEventListener("abort", onAbort, {
                  once: true
                });
            });
          if (stall === "list fetch") return waitForAbort();
          return { ok: true, json: waitForAbort } as unknown as Response;
        };
        const status = await collectKoedServerStatus(
          {
            HOME: root,
            KOED_HOME: root,
            KOED_REPO_ROOT: root,
            KOED_RUNTIME_MODE: "external",
            KOED_DEPENDENCY_MODE: "external",
            DATABASE_URL: "postgres://operator/database",
            REDIS_URL: "redis://operator:6379",
            EMBEDDING_SERVICE_URL: "http://embedding:8000",
            MEMORY_API_TOKEN: "test"
          },
          {
            fetch: fetcher,
            spawnSync: (() => ({
              stdout: "",
              stderr: "",
              status: 0,
              signal: null,
              pid: 1,
              output: []
            })) as never,
            checkPid: (pid) => [42, 43, 44].includes(pid),
            now: () => new Date("2026-01-01T00:00:00.000Z")
          }
        );
        expect(stalledRequests).toBe(1);
        expect(aborted).toBe(true);
        expect(status.historicalIngestion.codex.activity).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000
  );

  it("uses one deadline across list and detail requests", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({ runs: [{ id: "one" }] })
                }),
              1500
            );
          })
      )
      .mockImplementationOnce(
        () => new Promise(() => {})
      ) as unknown as typeof fetch;
    const activity = fetchHistoricalActivity({
      koedHome: "/fixture",
      apiUrl: "http://localhost:43300",
      token: "test",
      fetcher,
      readFile: () => JSON.stringify({ selectionFrozen: true, selections: [] })
    });
    let settled = false;
    void activity.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2100);
    expect(settled).toBe(true);
    expect(await activity).toBeNull();
  });
});
