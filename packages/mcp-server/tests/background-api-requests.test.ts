import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryApiClient } from "../src/index.js";
import { retryAfterMsFrom } from "../src/rate-limit-metadata.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const backgroundClient = () =>
  new MemoryApiClient({
    apiUrl: "http://localhost:3300",
    apiToken: "background-token",
    requestClass: "background"
  });

describe("background Memory API requests", () => {
  it("paces requests from concurrent background services without pacing recall", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const background = backgroundClient();
    const first = background.getEffectiveCapturePolicy({ threadId: "one" });
    const second = background.getEffectiveCapturePolicy({ threadId: "two" });
    const third = background.getEffectiveCapturePolicy({ threadId: "three" });
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    await new MemoryApiClient({
      apiUrl: "http://localhost:3300",
      apiToken: "recall-token"
    }).accessCheck();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    await third;
    expect(fetch).toHaveBeenCalledTimes(4);
    background.closeBackgroundRequests();
  });

  it("pauses the shared backlog after a 429 without replaying the failed write", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "2", "x-koed-rate-limit-source": "local" }
        })
      )
      .mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const background = backgroundClient();
    await expect(
      background.createSession({ idempotencyKey: "same-session" })
    ).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 2000,
      rateLimitSource: "local"
    });
    const second = background.getEffectiveCapturePolicy({ threadId: "two" });
    const third = background.getEffectiveCapturePolicy({ threadId: "three" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await third;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/sessions"))
    ).toHaveLength(1);
    background.closeBackgroundRequests();
  });

  it("uses a shared 60-second fallback when retry advice is invalid and cancels on shutdown", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "invalid" }
      })
    );
    vi.stubGlobal("fetch", fetch);
    const background = backgroundClient();
    await expect(background.accessCheck()).rejects.toMatchObject({
      status: 429
    });
    const pending = expect(
      background.getEffectiveCapturePolicy({})
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    background.closeBackgroundRequests();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts HTTP-date advice and bounds retry durations", () => {
    const now = Date.parse("2026-10-08T18:00:00Z");
    expect(retryAfterMsFrom("Thu, 08 Oct 2026 18:00:02 GMT", now)).toBe(2000);
    expect(retryAfterMsFrom("600", now)).toBe(300_000);
    expect(retryAfterMsFrom("0", now)).toBeUndefined();
    expect(retryAfterMsFrom("invalid", now)).toBeUndefined();
    expect(
      retryAfterMsFrom("Thu, 08 Oct 2026 17:59:59 GMT", now)
    ).toBeUndefined();
  });

  it.each(["local", "remote", "PRIVATE_INVALID_SOURCE"])(
    "validates API throttle source %s and preserves HTTP-date advice",
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-08T18:00:00Z"));
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("{}", {
          status: 429,
          headers: {
            "retry-after": "Thu, 08 Oct 2026 18:00:07 GMT",
            "x-koed-rate-limit-source": source
          }
        })
      );
      vi.stubGlobal("fetch", fetch);
      const client = new MemoryApiClient({
        apiUrl: "http://localhost:3300",
        apiToken: "recall-token"
      });
      await expect(client.accessCheck()).rejects.toMatchObject({
        status: 429,
        retryAfterMs: 7000,
        rateLimitSource:
          source === "local" || source === "remote" ? source : undefined
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
});
