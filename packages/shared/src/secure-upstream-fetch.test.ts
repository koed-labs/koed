import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  classifyUpstreamAddress,
  createSecureUpstreamFetch,
  registeredPrivateNetworkPolicy
} from "./secure-upstream-fetch.js";

const createTestDispatcher = () =>
  ({ close: vi.fn(async () => undefined) }) as unknown as Dispatcher;

describe("secure upstream fetch", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "forbidden"],
    ["224.0.0.1", "forbidden"],
    ["::1", "loopback"],
    ["fd00::1", "private"],
    ["fe80::1", "forbidden"],
    ["2001:db8::1", "forbidden"]
  ])("classifies %s as %s", (address, expected) => {
    expect(classifyUpstreamAddress(address)).toBe(expected);
  });

  it("pins the approved DNS address and rejects redirects", async () => {
    const dispatcher = createTestDispatcher();
    const request = vi.fn<typeof fetch>(async () => new Response("ok"));
    const createDispatcher = vi.fn(() => dispatcher);
    const secureFetch = createSecureUpstreamFetch({
      dependencies: {
        lookup: async () => [{ address: "203.0.114.8", family: 4 }],
        createDispatcher,
        fetch: request
      }
    });

    await secureFetch("https://team.example.test/v1/capabilities", {
      redirect: "follow"
    });

    expect(createDispatcher).toHaveBeenCalledWith({
      hostname: "team.example.test",
      address: "203.0.114.8",
      family: 4
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      dispatcher
    });
    await secureFetch.close();
  });

  it("rejects metadata, disguised loopback, mixed-class DNS, and private DNS by default", async () => {
    const run = (addresses: { address: string; family: 4 | 6 }[]) =>
      createSecureUpstreamFetch({
        dependencies: {
          lookup: async () => addresses,
          createDispatcher: createTestDispatcher,
          fetch: async () => new Response("unexpected")
        }
      })("https://team.example.test/v1/capabilities");

    await expect(
      run([{ address: "169.254.169.254", family: 4 }])
    ).rejects.toThrow("forbidden network target");
    await expect(run([{ address: "127.0.0.1", family: 4 }])).rejects.toThrow(
      "indirectly to loopback"
    );
    await expect(
      run([
        { address: "203.0.114.8", family: 4 },
        { address: "10.0.0.8", family: 4 }
      ])
    ).rejects.toThrow("unapproved private network");
    await expect(run([{ address: "10.0.0.8", family: 4 }])).rejects.toThrow(
      "unapproved private network"
    );
  });

  it("allows private DNS only for a matching operator-managed backend", async () => {
    const dispatcher = createTestDispatcher();
    const request = vi.fn(async () => new Response("ok"));
    const policy = registeredPrivateNetworkPolicy(() => [
      {
        baseUrl: "https://team.internal.example/koed",
        profile: "team_self_hosted"
      },
      {
        baseUrl: "https://cloud.example.test",
        profile: "koed_managed_cloud"
      }
    ]);
    const secureFetch = createSecureUpstreamFetch({
      allowPrivateNetworkForUrl: policy,
      dependencies: {
        lookup: async () => [{ address: "10.0.0.8", family: 4 }],
        createDispatcher: () => dispatcher,
        fetch: request
      }
    });

    await expect(
      secureFetch("https://team.internal.example/koed/v1/capabilities")
    ).resolves.toBeInstanceOf(Response);
    await expect(
      secureFetch("https://cloud.example.test/v1/capabilities")
    ).rejects.toThrow("unapproved private network");
    await secureFetch.close();
  });

  it("reuses a dispatcher for the same approved resolved target", async () => {
    const dispatcher = createTestDispatcher();
    const createDispatcher = vi.fn(() => dispatcher);
    const secureFetch = createSecureUpstreamFetch({
      dependencies: {
        lookup: async () => [{ address: "203.0.114.8", family: 4 }],
        createDispatcher,
        fetch: async () => new Response("ok")
      }
    });

    await secureFetch("https://team.example.test/v1/capabilities");
    await secureFetch("https://team.example.test/v1/status");

    expect(createDispatcher).toHaveBeenCalledTimes(1);
    await secureFetch.close();
  });

  it("closes every pooled dispatcher once and rejects later requests", async () => {
    const dispatchers = [createTestDispatcher(), createTestDispatcher()];
    const createDispatcher = vi
      .fn()
      .mockReturnValueOnce(dispatchers[0])
      .mockReturnValueOnce(dispatchers[1]);
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "203.0.114.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "203.0.114.9", family: 4 }]);
    const secureFetch = createSecureUpstreamFetch({
      dependencies: {
        lookup,
        createDispatcher,
        fetch: async () => new Response("ok")
      }
    });

    await secureFetch("https://team.example.test/v1/capabilities");
    await secureFetch("https://team.example.test/v1/status");
    await Promise.all([secureFetch.close(), secureFetch.close()]);

    expect(dispatchers[0]!.close).toHaveBeenCalledTimes(1);
    expect(dispatchers[1]!.close).toHaveBeenCalledTimes(1);
    await expect(
      secureFetch("https://team.example.test/v1/capabilities")
    ).rejects.toThrow("is closed");
  });
});
