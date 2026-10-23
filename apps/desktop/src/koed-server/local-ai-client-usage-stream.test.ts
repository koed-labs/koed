import { describe, expect, it, vi } from "vitest";
import {
  parseUsageSseFrame,
  subscribeLocalAiClientUsage,
  type UsageStreamAuthority
} from "./local-ai-client-usage-stream.js";

const event = (completionId: string) =>
  `event: usage\ndata: ${JSON.stringify({
    instanceId: "codex.default",
    completionId,
    outcome: "checked",
    observedAt: "2026-10-23T12:00:00.000Z"
  })}\n\n`;

describe("local AI Client usage stream", () => {
  it("accepts metadata-only completion frames", () => {
    expect(parseUsageSseFrame(event("one").trim())).toMatchObject({
      kind: "completion",
      completionId: "one"
    });
    expect(parseUsageSseFrame("event: usage\ndata: not-json")).toBeNull();
    expect(
      parseUsageSseFrame('event: usage\ndata: {"accountIdentityHash":"secret"}')
    ).toBeNull();
  });

  it("catches up after connect, drops queued stale events and closes idle reads on authority loss", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as typeof globalThis.fetch;
    const encoder = new TextEncoder();
    let generation = "first";
    const authority = async (): Promise<UsageStreamAuthority> => ({
      key: generation,
      localKey: generation,
      apiOrigin: "http://127.0.0.1:3300/",
      authorization: "Bearer test",
      profileScopeHash: "a".repeat(64),
      allowedInstances: new Set(["codex.default"])
    });
    const changes: string[] = [];
    const abort = new AbortController();
    const done = subscribeLocalAiClientUsage({
      fetch,
      authority,
      localAuthority: async () => generation,
      signal: abort.signal,
      onChange(change) {
        changes.push(
          change.kind === "completion" ? change.completionId : change.kind
        );
      }
    });
    const until = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 80 && !condition(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(condition()).toBe(true);
    };
    await until(() => controllers.length === 1 && changes.includes("catch_up"));
    controllers[0]!.enqueue(encoder.encode(event("one")));
    await until(() => changes.includes("one"));
    generation = "second";
    await until(() => controllers.length >= 2);
    // Any old queued frame after authority changed cannot cross to the new generation.
    try {
      controllers[0]!.enqueue(encoder.encode(event("stale")));
    } catch {
      /* cancelled */
    }
    await until(
      () => changes.filter((change) => change === "catch_up").length === 2
    );
    expect(changes).not.toContain("stale");
    controllers[1]!.enqueue(encoder.encode(event("two")));
    await until(() => changes.includes("two"));
    abort.abort();
    await done;
    expect(changes).toEqual([
      "catch_up",
      "one",
      "invalidated",
      "catch_up",
      "two"
    ]);
  }, 8_000);

  it("invalidates once on idle sign-out even when reconnect cannot authenticate", async () => {
    let signedOut = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* Keep the subscribed read idle. */
            }
          }),
          { status: 200 }
        )
    ) as typeof globalThis.fetch;
    const changes: string[] = [];
    const abort = new AbortController();
    const done = subscribeLocalAiClientUsage({
      fetch,
      signal: abort.signal,
      localAuthority: async () => {
        if (signedOut) throw new Error("signed out");
        return "owner/profile";
      },
      authority: async () => {
        if (signedOut) throw new Error("signed out");
        return {
          key: "owner/profile/generation",
          localKey: "owner/profile",
          apiOrigin: "http://127.0.0.1:3300/",
          authorization: "Bearer fixture",
          profileScopeHash: "a".repeat(64),
          allowedInstances: new Set(["codex.default"])
        };
      },
      onChange: (change) => {
        changes.push(change.kind);
      }
    });
    try {
      await vi.waitFor(() => expect(changes).toEqual(["catch_up"]));
      signedOut = true;
      await vi.waitFor(
        () => expect(changes).toEqual(["catch_up", "invalidated"]),
        { timeout: 3_000 }
      );
      await new Promise((resolve) => setTimeout(resolve, 1_650));
      expect(changes).toEqual(["catch_up", "invalidated"]);
    } finally {
      abort.abort();
      await done;
    }
  }, 5_000);

  it("does not report success for a same-authority transient stream failure", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 503 })
    ) as typeof globalThis.fetch;
    const changes: string[] = [];
    const abort = new AbortController();
    const done = subscribeLocalAiClientUsage({
      fetch,
      signal: abort.signal,
      localAuthority: async () => "same-owner",
      authority: async () => ({
        key: "same-owner/epoch",
        localKey: "same-owner",
        apiOrigin: "http://127.0.0.1:3300/",
        authorization: "Bearer fixture",
        profileScopeHash: "a".repeat(64),
        allowedInstances: new Set(["codex.default"])
      }),
      onChange: (change) => {
        changes.push(change.kind);
      }
    });
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(changes).toEqual([]);
    } finally {
      abort.abort();
      await done;
    }
  });

  it("invalidates a bound stream when authority cannot be verified after a failed reconnect", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let authorityAvailable = true;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(current) {
              controller = current;
            }
          }),
          { status: 200 }
        )
    ) as typeof globalThis.fetch;
    const changes: string[] = [];
    const abort = new AbortController();
    const authority = async (): Promise<UsageStreamAuthority> => {
      if (!authorityAvailable) throw new Error("revoked");
      return {
        key: "owner/epoch",
        localKey: "owner",
        apiOrigin: "http://127.0.0.1:3300/",
        authorization: "Bearer fixture",
        profileScopeHash: "a".repeat(64),
        allowedInstances: new Set(["codex.default"])
      };
    };
    const done = subscribeLocalAiClientUsage({
      fetch,
      signal: abort.signal,
      authority,
      localAuthority: async () => "owner",
      onChange: (change) => changes.push(change.kind)
    });
    try {
      await vi.waitFor(() => expect(changes).toEqual(["catch_up"]));
      // The local key still matches; only reconnect discovers the revoked authority.
      authorityAvailable = false;
      controller!.error(new Error("connection failed"));
      await vi.waitFor(
        () => expect(changes).toEqual(["catch_up", "invalidated"]),
        { timeout: 3_000 }
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await done;
    }
  }, 5_000);
});
