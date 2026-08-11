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

  it("can read a bounded JSON error envelope under the same deadline", async () => {
    const result = await fetchBoundedJsonObject(
      async () => Response.json({ code: "conflict" }, { status: 409 }),
      new URL("https://example.com"),
      {},
      { timeoutMs: 100, maxBytes: 1_000, readErrorBody: true }
    );
    expect(result.response.status).toBe(409);
    expect(result.payload).toEqual({ code: "conflict" });
  });

  it("composes caller abort with the bounded request timeout", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const request = fetchBoundedJsonObject(
      async (_input, init) => {
        receivedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("caller aborted")),
            { once: true }
          );
        });
      },
      new URL("https://example.com"),
      {},
      { timeoutMs: 10_000, maxBytes: 1_000, signal: controller.signal }
    );
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("rejects an already-aborted bounded request without starting the fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      fetchBoundedJsonObject(
        fetcher,
        new URL("https://example.com"),
        {},
        { timeoutMs: 10_000, maxBytes: 1_000, signal: controller.signal }
      )
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels an active never-ending response body when the caller aborts", async () => {
    const controller = new AbortController();
    let canceled = false;
    const request = fetchBoundedJsonObject(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              canceled = true;
            }
          })
        ),
      new URL("https://example.com"),
      {},
      { timeoutMs: 10_000, maxBytes: 1_000, signal: controller.signal }
    );
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(canceled).toBe(true);
  });

  it("rejects promptly when fetch ignores the caller signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const request = fetchBoundedJsonObject(
      async () => {
        calls += 1;
        return await new Promise<Response>(() => undefined);
      },
      new URL("https://example.com"),
      {},
      { timeoutMs: 10_000, maxBytes: 1_000, signal: controller.signal }
    );
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("composes two caller signals and rejects if either aborts", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const request = fetchBoundedJsonObject(
      async () => await new Promise<Response>(() => undefined),
      new URL("https://example.com"),
      { signal: first.signal },
      { timeoutMs: 10_000, maxBytes: 1_000, signal: second.signal }
    );
    second.abort();
    await expect(request).rejects.toThrow();
    expect(first.signal.aborted).toBe(false);
  });
});
