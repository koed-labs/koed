import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  classifyUpstreamAddress,
  createSecureUpstreamFetch,
  registeredPrivateNetworkPolicy
} from "./secure-upstream-fetch.js";

const dispatcher = {} as Dispatcher;

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
  });

  it("rejects metadata, disguised loopback, mixed-class DNS, and private DNS by default", async () => {
    const run = (addresses: { address: string; family: 4 | 6 }[]) =>
      createSecureUpstreamFetch({
        dependencies: {
          lookup: async () => addresses,
          createDispatcher: () => dispatcher,
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
  });
});
