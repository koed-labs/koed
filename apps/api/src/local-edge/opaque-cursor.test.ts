import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openOpaqueCursor, sealOpaqueCursor } from "./opaque-cursor.js";

describe("opaque local-edge cursors", () => {
  it("round-trips only with the bound secret, prefix, and domain", () => {
    const secret = randomBytes(32);
    const payload = { boundarySequence: 42, scope: "team" };
    const cursor = sealOpaqueCursor({
      secret,
      prefix: "cursor1",
      domain: "messages",
      payload
    });

    expect(cursor).toMatch(/^cursor1\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
    );
    expect(
      openOpaqueCursor({
        secret,
        prefix: "cursor1",
        domain: "messages",
        cursor
      })
    ).toEqual(payload);
    expect(
      openOpaqueCursor({
        secret: randomBytes(32),
        prefix: "cursor1",
        domain: "messages",
        cursor
      })
    ).toBeNull();
    expect(
      openOpaqueCursor({
        secret,
        prefix: "cursor1",
        domain: "other",
        cursor
      })
    ).toBeNull();
  });

  it("rejects tampering, malformed encodings, and oversized payloads", () => {
    const secret = randomBytes(32);
    const cursor = sealOpaqueCursor({
      secret,
      prefix: "cursor1",
      domain: "messages",
      payload: { offset: 10 }
    });
    const replacement = cursor.endsWith("A") ? "B" : "A";
    expect(
      openOpaqueCursor({
        secret,
        prefix: "cursor1",
        domain: "messages",
        cursor: `${cursor.slice(0, -1)}${replacement}`
      })
    ).toBeNull();
    expect(
      openOpaqueCursor({
        secret,
        prefix: "cursor1",
        domain: "messages",
        cursor: "cursor1.not+base64url"
      })
    ).toBeNull();
    expect(() =>
      sealOpaqueCursor({
        secret,
        prefix: "cursor1",
        domain: "messages",
        payload: { value: "x".repeat(5_000) }
      })
    ).toThrow("maximum size");
  });
});
