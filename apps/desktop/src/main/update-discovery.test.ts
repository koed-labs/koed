import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpdateDiscovery,
  officialReleasePage
} from "./update-discovery.js";

const version = (value: string) => ({
  tag_name: `v${value}`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-05T12:00:00Z",
  html_url: officialReleasePage(value),
  body: `Release ${value}`,
  assets: [
    {
      name: `Koed-${value}-arm64.dmg`,
      state: "uploaded",
      size: 100,
      digest: `sha256:${"a".repeat(64)}`,
      browser_download_url: `https://github.com/koed-labs/koed/releases/download/v${value}/Koed-${value}-arm64.dmg`
    },
    {
      name: "koed-desktop-macos-arm64.sha256",
      state: "uploaded",
      size: 100,
      digest: `sha256:${"b".repeat(64)}`,
      browser_download_url: `https://github.com/koed-labs/koed/releases/download/v${value}/koed-desktop-macos-arm64.sha256`
    }
  ]
});
const response = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
const fetchForPages = (
  pages: unknown[][],
  headers: Record<string, string> = {}
) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"))!;
    const link: Record<string, string> =
      page < pages.length
        ? {
            link: `<https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=${page + 1}>; rel="next"`
          }
        : {};
    return response(pages[page - 1] ?? [], { ...link, ...headers });
  }) as unknown as typeof fetch;

afterEach(() => vi.useRealTimers());

describe("update discovery", () => {
  it("never schedules or checks in ineligible builds", async () => {
    const fetcher = vi.fn();
    const discovery = createUpdateDiscovery({
      eligible: false,
      installedVersion: "0.10.0",
      fetch: fetcher as unknown as typeof fetch
    });
    discovery.start();
    expect(discovery.current().status).toBe("disabled");
    expect((await discovery.check()).status).toBe("disabled");
    expect(fetcher).not.toHaveBeenCalled();
    discovery.dispose();
  });

  it("selects highest stable release across locally constructed pages", async () => {
    const fetcher = fetchForPages([
      [version("0.10.1")],
      [version("0.11.0"), version("1.0.0")],
      []
    ]);
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.10.0",
      fetch: fetcher
    });
    const result = await discovery.check();
    expect(result.status).toBe("available");
    expect(result.release?.version).toBe("1.0.0");
    expect(fetcher).toHaveBeenCalledTimes(3);
    discovery.dispose();
  });

  it("rejects malicious pagination and redirected responses", async () => {
    const malicious = fetchForPages([[version("0.11.0")]], {
      link: '<https://evil.example/releases?page=2>; rel="next"'
    });
    expect(
      (
        await createUpdateDiscovery({
          eligible: true,
          installedVersion: "0.10.0",
          fetch: malicious
        }).check()
      ).status
    ).toBe("error");
    const redirected = vi.fn(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    Object.defineProperty(await redirected(), "redirected", { value: true });
    const fetchRedirect = vi.fn(async () => {
      const res = await redirected();
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }) as unknown as typeof fetch;
    expect(
      (
        await createUpdateDiscovery({
          eligible: true,
          installedVersion: "0.10.0",
          fetch: fetchRedirect
        }).check()
      ).status
    ).toBe("error");
  });

  it("fails closed when highest stable release lacks required assets", async () => {
    const incomplete = { ...version("0.11.0"), assets: [] };
    const fetcher = fetchForPages([[version("0.10.1")], [incomplete], []]);
    const result = await createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.10.0",
      fetch: fetcher
    }).check();
    expect(result.status).toBe("error");
    expect(result.release).toBeNull();
  });

  it("rejects an aggregate response exceeding scan budget", async () => {
    const pages = Array.from({ length: 6 }, (_, index) =>
      index === 0 ? [version("0.11.0")] : []
    );
    let calls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      calls += 1;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"))!;
      const payload =
        JSON.stringify(pages[page - 1] ?? []) + " ".repeat(1_800_000);
      const link: Record<string, string> =
        page < 6
          ? {
              link: `<https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=${page + 1}>; rel="next"`
            }
          : {};
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json", ...link }
      });
    }) as unknown as typeof fetch;
    expect(
      (
        await createUpdateDiscovery({
          eligible: true,
          installedVersion: "0.10.0",
          fetch: fetcher
        }).check()
      ).status
    ).toBe("error");
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("shares concurrent checks and suppresses stale results after disposal", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    ) as unknown as typeof fetch;
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.10.0",
      fetch: fetcher
    });
    const listener = vi.fn();
    discovery.subscribe(listener);
    const first = discovery.check();
    const second = discovery.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    discovery.dispose();
    resolveResponse(response([version("0.11.0")]));
    expect((await first).status).toBe("checking");
    expect(await second).toEqual(await first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("bounds metadata requests with a 10-second timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    ) as unknown as typeof fetch;
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.10.0",
      fetch: fetcher
    });
    const pending = discovery.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe("error");
    discovery.dispose();
  });

  it("applies cooldown after a completed check", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response([])) as unknown as typeof fetch;
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.10.0",
      fetch: fetcher
    });
    await discovery.check();
    await discovery.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    discovery.dispose();
  });
});
