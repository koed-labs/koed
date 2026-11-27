import { describe, expect, it } from "vitest";
import {
  decodeEnrollmentFenceMessage,
  encodeEnrollmentFenceMessage
} from "./enrollment-fence-ipc-codec.js";

const instanceId = "123e4567-e89b-42d3-a456-426614174000";
const epochId = "123e4567e89b42d3a456426614174001-0000000000000001";
const operationId = "123e4567-e89b-42d3-a456-426614174002";
const ids = { instanceId, epochId };
const operationIds = { ...ids, operationId };
const messages = [
  { v: 1, type: "ready", instanceId },
  { v: 1, type: "request", seq: 1, op: "create", args: {} },
  { v: 1, type: "request", seq: 2, op: "register", args: ids },
  { v: 1, type: "request", seq: 3, op: "fenceEpoch", args: ids },
  { v: 1, type: "request", seq: 4, op: "fenceOperation", args: operationIds },
  {
    v: 1,
    type: "response",
    seq: 1,
    op: "create",
    result: { kind: "ok", ...ids }
  },
  {
    v: 1,
    type: "response",
    seq: 2,
    op: "register",
    result: { kind: "ok", ...operationIds }
  },
  {
    v: 1,
    type: "response",
    seq: 3,
    op: "fenceEpoch",
    result: { kind: "ok", ...ids, status: "pending" }
  },
  {
    v: 1,
    type: "response",
    seq: 4,
    op: "fenceOperation",
    result: { kind: "ok", ...operationIds, status: "drained" }
  },
  {
    v: 1,
    type: "response",
    seq: 100000,
    op: "create",
    result: { kind: "rejected", code: "invalid_input" }
  }
] as const;

describe("enrollment fence IPC codec", () => {
  it("round trips an identity-free bind and rejects additional fields", () => {
    const bind = {
      v: 1,
      type: "request",
      seq: 1,
      op: "bind",
      args: {}
    } as const;
    expect(decodeEnrollmentFenceMessage(JSON.stringify(bind))).toEqual(bind);
    expect(() =>
      decodeEnrollmentFenceMessage(
        JSON.stringify({ ...bind, args: { owner: "secret" } })
      )
    ).toThrow();
    const challenge = "0123456789abcdef0123456789abcdef";
    const response = {
      v: 1,
      type: "response",
      seq: 1,
      op: "bind",
      result: { kind: "ok", challenge }
    } as const;
    expect(decodeEnrollmentFenceMessage(JSON.stringify(response))).toEqual(
      response
    );
    const ack = {
      v: 1,
      type: "request",
      seq: 2,
      op: "bindAck",
      args: { challenge }
    } as const;
    expect(decodeEnrollmentFenceMessage(JSON.stringify(ack))).toEqual(ack);
    expect(() =>
      decodeEnrollmentFenceMessage(
        JSON.stringify({ ...ack, args: { challenge: "invalid" } })
      )
    ).toThrow();
  });
  it.each(messages)("round trips exact $type schema", (message) => {
    expect(
      decodeEnrollmentFenceMessage(encodeEnrollmentFenceMessage(message))
    ).toEqual(message);
  });

  it.each([
    null,
    [],
    {},
    { ...messages[0], v: 2 },
    { ...messages[0], extra: true },
    { ...messages[0], instanceId: instanceId.toUpperCase() },
    { ...messages[0], instanceId: "not-a-uuid" },
    { ...messages[1], seq: 0 },
    { ...messages[1], seq: 100001 },
    { ...messages[1], seq: 1.5 },
    { ...messages[1], seq: "1" },
    { ...messages[2], args: { ...ids, epochId: epochId.toUpperCase() } },
    {
      ...messages[2],
      args: { ...ids, epochId: "123e4567-e89b-42d3-a456-426614174001" }
    },
    {
      ...messages[5],
      result: { kind: "ok", ...ids, epochId: epochId.toUpperCase() }
    },
    {
      ...messages[5],
      result: {
        kind: "ok",
        ...ids,
        epochId: "123e4567-e89b-42d3-a456-426614174001"
      }
    },
    { ...messages[1], op: "unknown" },
    { ...messages[1], args: { nested: {} } },
    { ...messages[5], result: { kind: "ok", ...ids, status: "drained" } },
    { ...messages[7], result: { kind: "ok", ...ids, status: "unknown" } },
    { ...messages[9], result: { kind: "rejected", code: "unknown" } }
  ])("rejects invalid shape %j in both directions", (message) => {
    expect(() => encodeEnrollmentFenceMessage(message as never)).toThrow();
    expect(() =>
      decodeEnrollmentFenceMessage(JSON.stringify(message))
    ).toThrow();
  });

  it.each([
    "invalid_input",
    "instance_mismatch",
    "unknown_epoch",
    "unknown_operation",
    "owner_mismatch",
    "capacity_exceeded",
    "fenced"
  ] as const)("preserves fence error code %s", (code) => {
    const message = {
      ...messages[9],
      result: { kind: "rejected" as const, code }
    };
    expect(
      decodeEnrollmentFenceMessage(encodeEnrollmentFenceMessage(message))
    ).toEqual(message);
  });

  it.each([
    '{"v":1,"type":"ready","instanceId":"123e4567-e89b-42d3-a456-426614174000","__proto__":{}}',
    '{"v":1,"type":"request","seq":1,"op":"create","args":{"__proto__":{}}}',
    '{"v":1,"type":"response","seq":1,"op":"create","result":{"kind":"rejected","code":"invalid_input","__proto__":{}}}'
  ])("rejects own __proto__ fields in encode and decode", (wire) => {
    expect(() => decodeEnrollmentFenceMessage(wire)).toThrow();
    expect(() => encodeEnrollmentFenceMessage(JSON.parse(wire))).toThrow();
  });

  it.each([
    '{"v":1,"v":1,"type":"ready","instanceId":"123e4567-e89b-42d3-a456-426614174000"}',
    '{"v":1,"type":"request","seq":1,"op":"create","\\u006fp":"create","args":{}}',
    '{"v":1,"type":"request","seq":1,"op":"create","args":{"x":1,"x":2}}',
    '{"v":1,"type":"response","seq":1,"op":"create","result":{"kind":"rejected","kind":"rejected","code":"invalid_input"}}'
  ])("rejects duplicate JSON keys, including escaped names", (wire) => {
    expect(() => decodeEnrollmentFenceMessage(wire)).toThrow();
  });

  it("rejects non-string and malformed JSON", () => {
    for (const input of [null, {}, "{", "null", "[]"]) {
      expect(() => decodeEnrollmentFenceMessage(input)).toThrow();
    }
  });

  it("enforces UTF-8 byte limit before parsing", () => {
    const valid = JSON.stringify(messages[0]);
    expect(
      decodeEnrollmentFenceMessage(
        valid + " ".repeat(4096 - Buffer.byteLength(valid))
      )
    ).toEqual(messages[0]);
    expect(() =>
      decodeEnrollmentFenceMessage(
        valid + " ".repeat(4097 - Buffer.byteLength(valid))
      )
    ).toThrow();
    expect(() =>
      decodeEnrollmentFenceMessage(valid + "é".repeat(2048))
    ).toThrow();
  });

  it("rejects noncanonical sequence numbers in JSON", () => {
    for (const seq of ["1.0", "1e0", "1E+0"]) {
      expect(() =>
        decodeEnrollmentFenceMessage(
          `{"v":1,"type":"request","seq":${seq},"op":"create","args":{}}`
        )
      ).toThrow();
    }
  });

  it("rejects non-plain outgoing objects", () => {
    expect(() =>
      encodeEnrollmentFenceMessage(
        Object.assign(new (class {})(), messages[0]) as never
      )
    ).toThrow();
  });
});
