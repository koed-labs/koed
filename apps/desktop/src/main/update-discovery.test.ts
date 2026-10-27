import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateDiscovery, desktopReleaseMetadataUrl, officialReleasePage, updateNoticeEligible } from "./update-discovery.js";

const asset = (version: string, name: string) => ({
  name, state: "uploaded", size: 123,
  digest: `sha256:${"a".repeat(64)}`,
  browser_download_url: `https://github.com/koed-labs/koed/releases/download/v${version}/${name}`
});
const release = (version = "0.9.0") => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  published_at: "2026-10-01T00:00:00Z",
  html_url: officialReleasePage(version), body: "<b>Plain release notes</b>",
  assets: [asset(version, `Koed-${version}-arm64.dmg`), asset(version, "koed-desktop-macos-arm64.sha256")]
});
const setup = (body: unknown = release(), eligible = true, installedVersion = "0.8.1") => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  const discovery = createUpdateDiscovery({ eligible, installedVersion, fetch, random: () => 0.5 });
  return { discovery, fetch };
};
afterEach(() => vi.useRealTimers());

describe("Desktop notice discovery", () => {
  it("limits real network discovery to eligible packaged macOS arm64, excluding private smoke", () => {
    const input = { packaged: true, platform: "darwin", arch: "arm64", argv: [] as string[] };
    expect(updateNoticeEligible(input)).toBe(true);
    for (const patch of [{ packaged: false }, { platform: "linux" }, { arch: "x64" }, { argv: ["--koed-private-smoke"] }]) {
      expect(updateNoticeEligible({ ...input, ...patch })).toBe(false);
    }
  });
  it("reads only fixed public metadata and exposes plain text, not URLs", async () => {
    const { discovery, fetch } = setup();
    expect((await discovery.check()).release).toEqual({ version: "0.9.0", summary: "<b>Plain release notes</b>" });
    expect(discovery.current().status).toBe("available");
    expect(fetch).toHaveBeenCalledWith(desktopReleaseMetadataUrl, expect.objectContaining({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal) }));
    discovery.dispose();
  });

  it.each(["0.8.1", "0.7.9"])("reports current for non-newer stable %s", async (version) => {
    const { discovery } = setup(release(version));
    expect((await discovery.check()).status).toBe("current");
    discovery.dispose();
  });

  it.each(["0.8.1-beta.1", "dev", "01.2.3"])("disables unknown/development installed version %s", async (version) => {
    const { discovery, fetch } = setup(release(), true, version);
    discovery.start();
    expect((await discovery.check()).status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
    discovery.dispose();
  });

  it("never schedules or checks in ineligible builds", async () => {
    vi.useFakeTimers();
    const { discovery, fetch } = setup(release(), false);
    discovery.start(); discovery.start();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect((await discovery.check()).status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
    discovery.dispose();
  });

  it.each([
    { tag_name: "v01.0.0" }, { tag_name: "v0.9.0-beta.1" },
    { draft: true }, { prerelease: true }, { published_at: null },
    { html_url: "https://evil.test/release" },
    { assets: [] },
    { assets: [asset("0.9.0", "Koed-0.9.0-arm64.dmg"), asset("0.9.0", "koed-desktop-macos-arm64-unsigned.sha256")] }
  ])("rejects untrusted/unsupported release metadata %j", async (patch) => {
    const { discovery } = setup({ ...release(), ...patch });
    expect((await discovery.check()).status).toBe("error");
    expect(discovery.current().release).toBeNull();
    discovery.dispose();
  });

  it("bounds long release notes without hiding an otherwise supported update", async () => {
    const { discovery } = setup({ ...release(), body: "x".repeat(5000) });
    expect((await discovery.check()).release?.summary).toHaveLength(4000);
    discovery.dispose();
  });

  it("rejects malformed asset destinations, missing digests and unsafe sizes", async () => {
    for (const patch of [{ browser_download_url: "https://evil.test/x" }, { digest: null }, { size: 0 }, { state: "new" }]) {
      const body = release();
      const { discovery } = setup({ ...body, assets: [{ ...body.assets[0], ...patch }, body.assets[1]] });
      expect((await discovery.check()).status).toBe("error");
      discovery.dispose();
    }
  });

  it("coalesces requests and rate-bounds manual checks", async () => {
    const { discovery, fetch } = setup();
    const states: string[] = [];
    const unsubscribe = discovery.subscribe((state) => states.push(state.status));
    await Promise.all([discovery.check(), discovery.check()]);
    await discovery.check();
    expect(fetch).toHaveBeenCalledOnce();
    expect(states).toEqual(["checking", "available"]);
    unsubscribe(); discovery.dispose();
  });

  it("schedules once with jitter and uses bounded failure backoff", async () => {
    vi.useFakeTimers();
    const { discovery, fetch } = setup();
    fetch.mockRejectedValueOnce(new Error("secret token /private/path"));
    discovery.start(); discovery.start();
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

  it("bounds bodies and rejects wrong types, HTTP errors and redirects", async () => {
    for (const response of [
      new Response("x".repeat(262145), { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "text/html" } }),
      new Response("{}", { status: 429 }), new Response("not json", { headers: { "content-type": "application/json" } })
    ]) {
      const discovery = createUpdateDiscovery({ eligible: true, installedVersion: "0.8.1", fetch: async () => response });
      expect((await discovery.check()).status).toBe("error");
      discovery.dispose();
    }
  });

  it("times out requests and suppresses stale results after disposal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      signal = options?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const discovery = createUpdateDiscovery({ eligible: true, installedVersion: "0.8.1", fetch });
    const pending = discovery.check();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe("error");
    expect(signal?.aborted).toBe(true);
    discovery.dispose();
    const late = setup();
    const listener = vi.fn(); late.discovery.subscribe(listener);
    const check = late.discovery.check(); late.discovery.dispose();
    await check;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(late.discovery.current().release).toBeNull();
  });

  it("constructs only exact official release pages", () => {
    expect(officialReleasePage("0.9.0")).toBe("https://github.com/koed-labs/koed/releases/tag/v0.9.0");
    for (const version of ["../evil", "https://evil.test", "0.9.0?next=x", "01.0.0"]) {
      expect(() => officialReleasePage(version)).toThrow();
    }
  });
});
