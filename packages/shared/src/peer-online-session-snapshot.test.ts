import { describe, expect, it } from "vitest";
import {
  encodePeerOnlineSessionSnapshot,
  parsePeerOnlineSessionSnapshot,
  PEER_ONLINE_SESSION_SNAPSHOT_PROTOCOL
} from "./peer-online-session-snapshot.js";

const snapshot = {
  sourceSession: {
    sourceKind: "codex",
    sourceAdapterVersion: "codex-transcript-v1",
    externalSessionId: "thread-1"
  },
  items: [
    {
      sourceRecordType: "message",
      sourceSequence: "0",
      rawJson: JSON.stringify({ role: "user", content: "hello", n: 1.5 }),
      sourceHash: "hash-0"
    }
  ]
};

describe("peer-online session snapshot", () => {
  it("round-trips canonical v1 plaintext", () => {
    const bytes = encodePeerOnlineSessionSnapshot(snapshot);
    expect(parsePeerOnlineSessionSnapshot(bytes)).toEqual({
      protocol: PEER_ONLINE_SESSION_SNAPSHOT_PROTOCOL,
      ...snapshot
    });
  });

  it("rejects noncanonical, unknown-field, wrong-version and invalid UTF-8 input", () => {
    const canonical = encodePeerOnlineSessionSnapshot(snapshot).toString();
    const value = JSON.parse(canonical) as Record<string, unknown>;
    for (const bad of [
      Buffer.from(` ${canonical}`),
      Buffer.from(JSON.stringify(value, null, 2)),
      Buffer.from(canonical.replace("v1", "v2")),
      Buffer.from(
        canonical.replace('"sourceHash"', '"sessionId":"local","sourceHash"')
      ),
      Buffer.from(canonical.replace('"protocol"', '"metadata":{},"protocol"')),
      Buffer.from(
        canonical.replace('"sourceSequence":"0"', '"sourceSequence":0')
      ),
      Buffer.from(
        canonical.replace(
          /"rawJson":"(?:[^"\\]|\\.)*"/,
          '"rawJson":"{not json"'
        )
      ),
      Buffer.from([0xff, 0xfe])
    ])
      expect(parsePeerOnlineSessionSnapshot(bad)).toBeUndefined();
  });

  it("does not let a peer choose local identity, transport or visibility", () => {
    for (const field of [
      "sessionId",
      "visibility",
      "sourceTransport",
      "idempotencyKey",
      "metadata",
      "projectionStatus"
    ])
      expect(() =>
        encodePeerOnlineSessionSnapshot({
          ...snapshot,
          items: [{ ...snapshot.items[0]!, [field]: "x" }]
        })
      ).toThrow();
  });
});
