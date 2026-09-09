import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PortableClientEnvironmentRegistry,
  PortableClientDraftStore,
  PortableClientOutbox,
  PortableClientViewCache,
  portableClientNotificationSchema
} from "./client-foundation.js";

const authority = {
  backendId: "team-vps",
  principalId: "user-1",
  credentialReference: "device:opaque",
  credentialGeneration: 2,
  authorityGeneration: 3
};

class MemorySecureStore {
  readonly values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

describe("portable client foundation", () => {
  it("selects only a known, credential-free backend environment", () => {
    const registry = new PortableClientEnvironmentRegistry();
    registry.replace(
      [
        {
          id: "team-vps",
          displayName: "Team",
          baseUrl: "https://team.example.test",
          profile: "team_self_hosted",
          capabilitySchemaVersion: 9,
          bindingGeneration: 1
        }
      ],
      "team-vps"
    );
    expect(registry.active()?.baseUrl).toBe("https://team.example.test");
    expect(() =>
      registry.replace(registry.list(), "unknown-backend")
    ).toThrow();
    expect(() =>
      registry.replace(
        [
          {
            ...registry.list()[0],
            baseUrl: "https://token@team.example.test"
          }
        ],
        "team-vps"
      )
    ).toThrow();
  });

  it("invalidates cached views across authority generations and bounds LRU state", () => {
    let now = 1;
    const cache = new PortableClientViewCache<string>({
      maximumEntries: 2,
      retentionMs: 10,
      now: () => now
    });
    cache.remember("a", 1, "A");
    now += 1;
    cache.remember("b", 1, "B");
    now += 1;
    expect(cache.read("a", 1)).toBe("A");
    now += 1;
    cache.remember("c", 1, "C");
    expect(cache.read("b", 1)).toBeNull();
    expect(cache.read("a", 2)).toBeNull();
    now = 20;
    expect(cache.read("c", 1)).toBeNull();
  });

  it("persists dispatch before send and never replays an uncertain outcome", async () => {
    const store = new MemorySecureStore();
    const outbox = new PortableClientOutbox({
      namespace: "collaboration",
      store,
      parsePayload: (value) =>
        z
          .object({ body: z.string().max(1_000) })
          .strict()
          .parse(value),
      now: () => new Date("2026-08-19T00:00:00.000Z")
    });
    const queued = await outbox.enqueue(authority, {
      id: "message:fixture-0001",
      idempotencyKey: "message:fixture-0001",
      requestDigest: "a".repeat(64),
      payload: { body: "hello" }
    });
    expect(queued.state).toBe("queued");
    expect((await outbox.begin(authority, queued.id)).state).toBe(
      "dispatching"
    );
    await outbox.retry(authority, queued.id, false);
    await expect(outbox.begin(authority, queued.id)).rejects.toThrow(
      "indeterminate"
    );
    await outbox.complete(authority, queued.id);
    expect(store.values.size).toBe(0);
  });

  it("does not let another backend or authority generation read an outbox item", async () => {
    const store = new MemorySecureStore();
    const outbox = new PortableClientOutbox({
      namespace: "managed-conversation",
      store,
      parsePayload: (value) => z.string().parse(value)
    });
    await outbox.enqueue(authority, {
      id: "prompt:fixture-0001",
      idempotencyKey: "prompt:fixture-0001",
      requestDigest: "b".repeat(64),
      payload: "hello"
    });
    await expect(
      outbox.begin(
        { ...authority, authorityGeneration: 4 },
        "prompt:fixture-0001"
      )
    ).rejects.toThrow("unavailable");
  });

  it("keeps drafts in injected secure custody and separates authority generations", async () => {
    const store = new MemorySecureStore();
    const drafts = new PortableClientDraftStore({
      namespace: "drafts",
      store,
      maximumUtf8Bytes: 64,
      now: () => new Date("2026-08-19T00:00:00.000Z")
    });
    await drafts.write(authority, "thread:one", "unfinished");
    expect(await drafts.read(authority, "thread:one")).toBe("unfinished");
    expect(
      await drafts.read({ ...authority, credentialGeneration: 3 }, "thread:one")
    ).toBe("");
    await expect(
      drafts.write(authority, "thread:one", "x".repeat(65))
    ).rejects.toThrow("too large");
  });

  it("keeps notification intents content-free", () => {
    const notification = portableClientNotificationSchema.parse({
      version: 1,
      backendId: "team-vps",
      principalId: "user-1",
      eventId: "event-1",
      resourceKind: "mention",
      resourceId: "thread-1",
      badgeDelta: 1,
      occurredAt: "2026-08-19T00:00:00.000Z"
    });
    expect(notification.resourceKind).toBe("mention");
    expect(() =>
      portableClientNotificationSchema.parse({
        ...notification,
        body: "private message"
      })
    ).toThrow();
  });
});
