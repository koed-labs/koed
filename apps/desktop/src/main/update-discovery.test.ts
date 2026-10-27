import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpdateDiscovery,
  desktopReleaseMetadataUrl,
  officialReleasePage,
  updateNoticeEligible
} from "./update-discovery.js";

const asset = (version: string, name: string) => ({
  name,
  state: "uploaded",
  size: 123,
  digest: `sha256:${"a".repeat(64)}`,
  browser_download_url: `https://github.com/koed-labs/koed/releases/download/v${version}/${name}`
});
const release = (version = "0.9.0") => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-01T00:00:00Z",
  html_url: officialReleasePage(version),
  body: "<b>Plain release notes</b>",
  assets: [
    asset(version, `Koed-${version}-arm64.dmg`),
    asset(version, "koed-desktop-macos-arm64.sha256")
  ]
});
const setup = (
  body: unknown = release(),
  eligible = true,
  installedVersion = "0.8.1"
) => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(Array.isArray(body) ? body : [body]), {
        headers: { "content-type": "application/json" }
      })
  );
  const discovery = createUpdateDiscovery({
    eligible,
    installedVersion,
    fetch,
    random: () => 0.5
  });
  return { discovery, fetch };
};
afterEach(() => vi.useRealTimers());

describe("Desktop notice discovery", () => {
  it("limits real network discovery to eligible packaged macOS arm64, excluding private smoke", () => {
    const input = {
      packaged: true,
      platform: "darwin",
      arch: "arm64",
      argv: [] as string[]
    };
    expect(updateNoticeEligible(input)).toBe(true);
    for (const patch of [
      { packaged: false },
      { platform: "linux" },
      { arch: "x64" },
      { argv: ["--koed-private-smoke"] }
    ]) {
      expect(updateNoticeEligible({ ...input, ...patch })).toBe(false);
    }
  });
  it("reads only fixed public metadata and exposes plain text, not URLs", async () => {
    const { discovery, fetch } = setup();
    expect((await discovery.check()).release).toEqual({
      version: "0.9.0",
      summary: "<b>Plain release notes</b>"
    });
    expect(discovery.current().status).toBe("available");
    expect(fetch).toHaveBeenCalledWith(
      desktopReleaseMetadataUrl,
      expect.objectContaining({
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal)
      })
    );
    discovery.dispose();
  });

  it.each(["0.8.1", "0.7.9"])(
    "reports current for non-newer stable %s",
    async (version) => {
      const { discovery } = setup(release(version));
      expect((await discovery.check()).status).toBe("current");
      discovery.dispose();
    }
  );

  it.each(["0.8.1-beta.1", "dev", "01.2.3"])(
    "disables unknown/development installed version %s",
    async (version) => {
      const { discovery, fetch } = setup(release(), true, version);
      discovery.start();
      expect((await discovery.check()).status).toBe("disabled");
      expect(fetch).not.toHaveBeenCalled();
      discovery.dispose();
    }
  );

  it("never schedules or checks in ineligible builds", async () => {
    vi.useFakeTimers();
    const { discovery, fetch } = setup(release(), false);
    discovery.start();
    discovery.start();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect((await discovery.check()).status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
    discovery.dispose();
  });

  it.each([
    { published_at: null },
    { html_url: "https://evil.test/release" },
    { assets: [] },
    {
      assets: [
        asset("0.9.0", "Koed-0.9.0-arm64.dmg"),
        asset("0.9.0", "koed-desktop-macos-arm64-unsigned.sha256")
      ]
    }
  ])("rejects untrusted/unsupported release metadata %j", async (patch) => {
    const { discovery } = setup({ ...release(), ...patch });
    expect((await discovery.check()).status).toBe("error");
    expect(discovery.current().release).toBeNull();
    discovery.dispose();
  });

  it("selects the highest stable version across locally constructed pages", async () => {
    const urls: string[] = [];
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify(
            urls.length === 1
              ? [release("1.9.0"), { ...release(), prerelease: true }]
              : [release("1.10.0")]
          ),
          {
            headers: {
              "content-type": "application/json",
              ...(urls.length === 1
                ? {
                    link: '<https://api.github.com/repositories/1239895353/releases?per_page=100&page=2>; rel="next"'
                  }
                : {})
            }
          }
        );
      }
    });
    expect((await discovery.check()).release?.version).toBe("1.10.0");
    expect(urls).toEqual([
      "https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=1",
      "https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=2"
    ]);
    discovery.dispose();
  });

  it("reports error when no stable release exists", async () => {
    const { discovery } = setup([{ ...release(), prerelease: true }]);
    expect((await discovery.check()).status).toBe("error");
    discovery.dispose();
  });

  it("continues locally after a full page without a Link header", async () => {
    const urls: string[] = [];
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify(
            urls.length === 1
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...release(`0.0.${i}`),
                  body: "x".repeat(2200)
                }))
              : [release("1.0.0")]
          ),
          { headers: { "content-type": "application/json" } }
        );
      }
    });
    expect((await discovery.check()).release?.version).toBe("1.0.0");
    expect(urls).toEqual([
      desktopReleaseMetadataUrl,
      "https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=2"
    ]);
    discovery.dispose();
  });

  it("rejects an aggregate response exceeding the scan budget", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return new Response(
        JSON.stringify([
          { ...release(`1.0.${page}`), body: "x".repeat(1_900_000) }
        ]),
        {
          headers: {
            "content-type": "application/json",
            link: `<https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=${page + 1}>; rel="next"`
          }
        }
      );
    });
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch
    });
    expect((await discovery.check()).status).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(6);
    discovery.dispose();
  });

  it("ignores prereleases, drafts, and non-stable tags", async () => {
    const { discovery } = setup([
      { ...release("9.0.0"), prerelease: true },
      { ...release("8.0.0"), draft: true },
      { ...release("7.0.0"), tag_name: "v7.0.0-beta.1" },
      release("1.0.0")
    ]);
    expect((await discovery.check()).release?.version).toBe("1.0.0");
    discovery.dispose();
  });

  it("fails closed when highest stable release lacks required assets", async () => {
    const { discovery } = setup([
      release("1.0.0"),
      { ...release("2.0.0"), assets: [] }
    ]);
    expect((await discovery.check()).status).toBe("error");
    discovery.dispose();
  });

  it.each(["2.0.0", "3.0.0"])(
    "reports current despite unsuitable highest stable assets when installed version is %s",
    async (installedVersion) => {
      const highest = release("2.0.0");
      const { discovery } = setup(
        [release("1.0.0"), { ...highest, assets: [] }],
        true,
        installedVersion
      );
      const result = await discovery.check();
      expect(result.status).toBe("current");
      expect(result.release).toBeNull();
      discovery.dispose();
    }
  );

  it("reports current for live v0.8.1 with unsigned checksum", async () => {
    const current = release("0.8.1");
    const { discovery } = setup({
      ...current,
      assets: [
        current.assets[0],
        asset("0.8.1", "koed-desktop-macos-arm64-unsigned.sha256")
      ]
    });
    const result = await discovery.check();
    expect(result.status).toBe("current");
    expect(result.release).toBeNull();
    discovery.dispose();
  });

  it("fails closed on pagination beyond the cap without requesting Link URLs", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return new Response(JSON.stringify([release()]), {
        headers: {
          "content-type": "application/json",
          link: `<https://api.github.com/repos/koed-labs/koed/releases?per_page=100&page=${page + 1}>; rel="next"`
        }
      });
    });
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch
    });
    expect((await discovery.check()).status).toBe("error");
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(10);
    discovery.dispose();
  });

  it("rejects malicious pagination and redirected responses", async () => {
    for (const response of [
      new Response("[]", {
        headers: {
          "content-type": "application/json",
          link: '<https://evil.test/>; rel="next"'
        }
      }),
      new Response("[]", {
        headers: { "content-type": "application/json", link: "not a link" }
      }),
      Response.redirect("https://evil.test/", 302),
      Object.defineProperty(
        new Response("[]", { headers: { "content-type": "application/json" } }),
        "redirected",
        { value: true }
      ),
      Object.defineProperty(
        new Response("[]", { headers: { "content-type": "application/json" } }),
        "url",
        { value: "https://evil.test/" }
      )
    ]) {
      const fetch = vi.fn(async () => response);
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch
      });
      expect((await discovery.check()).status).toBe("error");
      expect(fetch).toHaveBeenCalledOnce();
      discovery.dispose();
    }
  });

  it("bounds long release notes without hiding an otherwise supported update", async () => {
    const { discovery } = setup({ ...release(), body: "x".repeat(5000) });
    expect((await discovery.check()).release?.summary).toHaveLength(4000);
    discovery.dispose();
  });

  it("rejects malformed asset destinations, missing digests and unsafe sizes", async () => {
    for (const patch of [
      { browser_download_url: "https://evil.test/x" },
      { digest: null },
      { size: 0 },
      { state: "new" }
    ]) {
      const body = release();
      const { discovery } = setup({
        ...body,
        assets: [{ ...body.assets[0], ...patch }, body.assets[1]]
      });
      expect((await discovery.check()).status).toBe("error");
      discovery.dispose();
    }
  });

  it("clears an earlier notice when the next metadata check fails", async () => {
    vi.useFakeTimers();
    const { discovery, fetch } = setup();
    expect((await discovery.check()).status).toBe("available");
    await vi.advanceTimersByTimeAsync(60_000);
    fetch.mockRejectedValueOnce(new Error("unavailable"));
    const result = await discovery.check();
    expect(result.status).toBe("error");
    expect(result.release).toBeNull();
    discovery.dispose();
  });

  it("coalesces requests and rate-bounds manual checks", async () => {
    const { discovery, fetch } = setup();
    const states: string[] = [];
    const unsubscribe = discovery.subscribe((state) =>
      states.push(state.status)
    );
    await Promise.all([discovery.check(), discovery.check()]);
    await discovery.check();
    expect(fetch).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "available"]);
    unsubscribe();
    discovery.dispose();
  });

  it("schedules once with jitter and uses bounded failure backoff", async () => {
    vi.useFakeTimers();
    const { discovery, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("secret token /private/path"));
    discovery.start();
    discovery.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(discovery.current().status).toBe("error");
    expect(JSON.stringify(discovery.current())).not.toContain("secret");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(discovery.current().status).toBe("available");
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    discovery.dispose();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([403, 429])(
    "honors rate-limit retry delays for manual and automatic checks on %i",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const fetch = vi.fn(
        async () =>
          new Response("", { status, headers: { "retry-after": "1200" } })
      );
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch,
        random: () => 0.5
      });
      discovery.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(discovery.current().status).toBe("error");
      await vi.advanceTimersByTimeAsync(600_000);
      await discovery.check();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      discovery.dispose();
    }
  );

  it("honors rate-limit reset and bounded HTTP-date retry headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetch = vi.fn(
      async () =>
        new Response("", {
          status: 403,
          headers: {
            "retry-after": "Thu, 01 Jan 2026 00:10:00 GMT",
            "x-ratelimit-reset": String(Date.now() / 1000 + 1200)
          }
        })
    );
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch
    });
    await discovery.check();
    await vi.advanceTimersByTimeAsync(600_000);
    await discovery.check();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await discovery.check();
    expect(fetch).toHaveBeenCalledTimes(2);
    discovery.dispose();
  });

  it.each([["invalid", 60_000]])(
    "ignores invalid Retry-After %s",
    async (retry, delay) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const fetch = vi.fn(
        async () =>
          new Response("", { status: 429, headers: { "retry-after": retry } })
      );
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch
      });
      await discovery.check();
      await vi.advanceTimersByTimeAsync(delay - 1);
      await discovery.check();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await discovery.check();
      expect(fetch).toHaveBeenCalledTimes(2);
      discovery.dispose();
    }
  );

  it.each([
    ["retry-after", "86400"],
    ["retry-after", "9".repeat(400)],
    ["x-ratelimit-reset", "9999999999"],
    ["x-ratelimit-reset", "9".repeat(400)]
  ])(
    "does not retry early for long or overflowing %s",
    async (header, value) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const fetch = vi.fn(
        async () =>
          new Response("", { status: 429, headers: { [header]: value } })
      );
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch,
        random: () => 0.5
      });
      discovery.start();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(7 * 3600_000);
      await discovery.check();
      expect(fetch).toHaveBeenCalledOnce();
      discovery.dispose();
    }
  );

  it.each(["automatic", "manual"])(
    "resumes %s checks after a long finite rate-limit deadline",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const fetch = vi
        .fn(
          async () =>
            new Response(JSON.stringify([release()]), {
              headers: { "content-type": "application/json" }
            })
        )
        .mockResolvedValueOnce(
          new Response("", { status: 429, headers: { "retry-after": "28800" } })
        );
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch,
        random: () => 0.5
      });
      if (mode === "automatic") {
        discovery.start();
        await vi.advanceTimersByTimeAsync(5000);
      } else {
        await discovery.check();
      }
      await vi.advanceTimersByTimeAsync(8 * 3600_000 - 1);
      await discovery.check();
      expect(fetch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      if (mode === "manual") await discovery.check();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(discovery.current().status).toBe("available");
      discovery.dispose();
    }
  );

  it("resumes automatically after a deadline beyond the maximum timer delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetch = vi
      .fn(
        async () =>
          new Response(JSON.stringify([release()]), {
            headers: { "content-type": "application/json" }
          })
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 403,
          headers: { "x-ratelimit-reset": "1769817605" }
        })
      );
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch,
      random: () => 0.5
    });
    discovery.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000 - 1);
    await discovery.check();
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(discovery.current().status).toBe("available");
    discovery.dispose();
  });

  it.each([403, 429, 500])(
    "cancels rejected HTTP response body on %i",
    async (status) => {
      const cancel = vi.fn();
      const body = new ReadableStream({ cancel });
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch: async () => new Response(body, { status })
      });
      expect((await discovery.check()).status).toBe("error");
      expect(cancel).toHaveBeenCalledOnce();
      discovery.dispose();
    }
  );

  it("bounds bodies and rejects wrong types, HTTP errors and redirects", async () => {
    for (const response of [
      new Response("x".repeat(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" }
      }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{}", { status: 429 }),
      new Response("not json", {
        headers: { "content-type": "application/json" }
      })
    ]) {
      const discovery = createUpdateDiscovery({
        eligible: true,
        installedVersion: "0.8.1",
        fetch: async () => response
      });
      expect((await discovery.check()).status).toBe("error");
      discovery.dispose();
    }
  });

  it("times out requests and suppresses stale results after disposal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const discovery = createUpdateDiscovery({
      eligible: true,
      installedVersion: "0.8.1",
      fetch
    });
    const pending = discovery.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe("error");
    expect(signal?.aborted).toBe(true);
    discovery.dispose();
    const late = setup();
    const listener = vi.fn();
    late.discovery.subscribe(listener);
    const check = late.discovery.check();
    late.discovery.dispose();
    await check;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(late.discovery.current().release).toBeNull();
  });

  it("constructs only exact official release pages", () => {
    expect(officialReleasePage("0.9.0")).toBe(
      "https://github.com/koed-labs/koed/releases/tag/v0.9.0"
    );
    for (const version of [
      "../evil",
      "https://evil.test",
      "0.9.0?next=x",
      "01.0.0"
    ]) {
      expect(() => officialReleasePage(version)).toThrow();
    }
  });
});
