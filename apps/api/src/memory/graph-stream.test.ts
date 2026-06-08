import type { FastifyInstance, FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  canReceiveGraphStreamPayload,
  graphUpdateKey,
  guardedBroadcastGraphUpdate
} from "./graph-stream.js";

describe("graph stream updates", () => {
  it("keeps personal graph updates scoped to the owner", () => {
    expect(
      canReceiveGraphStreamPayload(
        { userId: "user-1" },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: "user-1"
        }
      )
    ).toBe(true);
    expect(
      canReceiveGraphStreamPayload(
        { userId: "user-2" },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: "user-1"
        }
      )
    ).toBe(false);
  });

  it("keys graph updates by personal owner or global fallback", () => {
    expect(
      graphUpdateKey({
        table: "memory_events",
        visibility: "personal",
        ownerUserId: "user-1"
      })
    ).toBe("personal:user-1");
    expect(graphUpdateKey({ table: "drizzle.__drizzle_migrations" })).toBe(
      "global"
    );
  });

  it("logs broadcast write failures without dropping later clients", () => {
    const warn = vi.fn();
    const app = {
      log: { warn }
    } as unknown as Pick<FastifyInstance, "log">;
    const failingReply = {
      raw: {
        write: vi.fn(() => {
          throw new Error("stream closed");
        })
      }
    } as unknown as FastifyReply;
    const writableReply = {
      raw: {
        write: vi.fn()
      }
    } as unknown as FastifyReply;

    expect(() =>
      guardedBroadcastGraphUpdate({
        app,
        clients: [
          { userId: "user-1", reply: failingReply },
          { userId: "user-1", reply: writableReply }
        ],
        payload: {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: "user-1"
        }
      })
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "graph_stream",
        event: expect.objectContaining({
          name: "graph_stream.broadcast_failed"
        })
      }),
      "could not broadcast graph update"
    );
    expect(writableReply.raw.write).toHaveBeenCalledWith(
      "event: graph_update\n"
    );
  });
});
