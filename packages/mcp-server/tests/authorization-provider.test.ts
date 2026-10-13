import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryApiClient } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("Memory API authorization provider", () => {
  it("resolves renewed credentials on each request and preserves shallow copies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const authorizationProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("Bearer first")
      .mockResolvedValueOnce("Bearer renewed");
    const client = new MemoryApiClient({
      apiUrl: "https://memory.example",
      apiToken: "unused",
      authorizationProvider
    });
    await client.accessCheck();
    await new MemoryApiClient({ ...client.config }).accessCheck();
    expect(
      fetch.mock.calls.map(
        ([, options]) =>
          (options?.headers as Record<string, string>).authorization
      )
    ).toEqual(["Bearer first", "Bearer renewed"]);
  });

  it("preserves explicit operation authorization without resolving the provider", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const authorizationProvider = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("secret"));
    const client = new MemoryApiClient({
      apiUrl: "https://memory.example",
      authorizationProvider
    });
    await client.teamMemorySearch("backend", {}, "Bearer explicit");
    expect(authorizationProvider).not.toHaveBeenCalled();
    expect(
      (fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)
        .authorization
    ).toBe("Bearer explicit");
  });

  it("fails closed without exposing credential errors or falling back to API tokens", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const client = new MemoryApiClient({
      apiUrl: "https://memory.example",
      apiToken: "fallback-secret",
      authorizationProvider: async () => {
        throw new Error("refresh-secret");
      }
    });
    await expect(client.accessCheck()).rejects.toMatchObject({
      message: "Memory API authorization is unavailable.",
      status: 401,
      payload: undefined
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains API Token authorization for existing clients", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await new MemoryApiClient({
      apiUrl: "http://localhost:3300",
      apiToken: "existing"
    }).accessCheck();
    expect(
      (fetch.mock.calls[0]?.[1]?.headers as Record<string, string>)
        .authorization
    ).toBe("Bearer existing");
  });
});
