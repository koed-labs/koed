import { describe, expect, it, vi } from "vitest";
import {
  fetchWithTimeout,
  fetchBoundedJsonObject,
  readBoundedJsonObject,
  RemoteRequestTimeoutError,
  RemoteResponseLimitError,
  upstreamApiUrl
} from "./bounded-http.js";

describe("bounded HTTP helpers", () => {
  it("preserves an upstream deployment base path", () => {
    expect(
      upstreamApiUrl(
        "https://example.com/koed/",
        "/v1/cross-identity-sync/intake/context"
      ).toString()
    ).toBe("https://example.com/koed/v1/cross-identity-sync/intake/context");
  });
  it("aborts stalled requests at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const request = fetchWithTimeout(
        () => new Promise<Response>(() => undefined),
        new URL("https://example.com"),
        {},
        100
      );
      const assertion = expect(request).rejects.toBeInstanceOf(
        RemoteRequestTimeoutError
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects declared and streamed response bodies over the byte limit", async () => {
    await expect(
      readBoundedJsonObject(
        new Response("{}", { headers: { "content-length": "200" } }),
        100
      )
    ).rejects.toBeInstanceOf(RemoteResponseLimitError);
    await expect(
      readBoundedJsonObject(
        new Response(JSON.stringify({ value: "x".repeat(200) })),
        100
      )
    ).rejects.toBeInstanceOf(RemoteResponseLimitError);
  });

  it("requires a JSON object response", async () => {
    await expect(
      readBoundedJsonObject(
        new Response(JSON.stringify(["not", "an", "object"])),
        100
      )
    ).rejects.toThrow("JSON object");
  });

  it("applies the deadline while streaming the response body", async () => {
    vi.useFakeTimers();
    try {
      const request = fetchBoundedJsonObject(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              }
            })
          ),
        new URL("https://example.com"),
        {},
        { timeoutMs: 100, maxBytes: 1_000 }
      );
      const assertion = expect(request).rejects.toBeInstanceOf(
        RemoteRequestTimeoutError
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not parse an unsuccessful non-JSON response", async () => {
    const result = await fetchBoundedJsonObject(
      async () => new Response("gateway failure", { status: 502 }),
      new URL("https://example.com"),
      {},
      { timeoutMs: 100, maxBytes: 1_000 }
    );
    expect(result.response.status).toBe(502);
    expect(result.payload).toEqual({});
  });
});
