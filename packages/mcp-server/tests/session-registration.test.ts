import { afterEach, expect, it, vi } from "vitest";
import { MemoryApiClient } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries rate-limited registration with the same identity after Retry-After", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "retry-after": "2" }
      })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ session: { id: "session-1" } }))
    );
  vi.stubGlobal("fetch", fetch);
  const client = new MemoryApiClient({
    apiToken: "test-token",
    apiUrl: "http://localhost:3000",
    requestClass: "managed-conversation"
  });
  const pending = client.createSession({
    idempotencyKey: "same-session",
    externalSessionId: "thread-1"
  });
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({ session: { id: "session-1" } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
    "x-koed-request-class": "managed-conversation"
  });
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
});

it.each([401, 403, 500])(
  "does not retry registration rejected with %s",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}", { status }));
    vi.stubGlobal("fetch", fetch);
    const client = new MemoryApiClient({
      apiToken: "test-token",
      apiUrl: "http://localhost:3000"
    });
    await expect(
      client.createSession({ idempotencyKey: "same-session" })
    ).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

it("bounds retries when registration remains rate limited", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response("{}", { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const client = new MemoryApiClient({
    apiToken: "test-token",
    apiUrl: "http://localhost:3000"
  });
  const checked = expect(
    client.createSession({ idempotencyKey: "same-session" })
  ).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(3000);
  await checked;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("retries throttled managed response persistence without resending a provider prompt", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "retry-after": "2" } })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ artifact: { id: "artifact-1" } }))
    );
  vi.stubGlobal("fetch", fetch);
  const client = new MemoryApiClient({
    apiUrl: "http://localhost:3000",
    apiToken: "test-token",
    requestClass: "managed-conversation"
  });
  const pending = client.ensureConversationSourceArtifact({
    externalSessionId: "same-thread"
  });
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toEqual({ artifact: { id: "artifact-1" } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toBe(fetch.mock.calls[1]?.[0]);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
});
