import { describe, expect, it } from "vitest";
import {
  controlHelloSchema,
  controlReplySchema,
  controlRequestSchema
} from "./local-control-protocol.js";

const request = {
  requestId: "request-1",
  instanceId: "instance-1",
  expectedRevision: 0,
  command: { action: "start", explicit: true }
};

describe("local control request validation", () => {
  it("accepts a valid start request", () => {
    expect(controlRequestSchema.parse(request)).toEqual(request);
  });

  it("binds retirement to an instance and revision without accepting extra authority", () => {
    const retirement = { ...request, command: { action: "retire" } };
    expect(controlRequestSchema.parse(retirement)).toEqual(retirement);
    expect(
      controlRequestSchema.safeParse({
        ...retirement,
        command: { action: "retire", pid: 123 }
      }).success
    ).toBe(false);
    expect(
      controlRequestSchema.safeParse({
        ...retirement,
        expectedRevision: undefined
      }).success
    ).toBe(false);
  });

  it("rejects unknown actions, fields, and invalid revisions", () => {
    for (const value of [
      { ...request, command: { action: "execute", executable: "/bin/sh" } },
      { ...request, command: { ...request.command, executable: "/bin/sh" } },
      { ...request, expectedRevision: -1 },
      { ...request, expectedRevision: 1.5 },
      { ...request, unexpected: true }
    ]) {
      expect(controlRequestSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects malformed hello and reply payloads", () => {
    const hello = {
      protocolVersion: 1,
      home: "/home/test",
      installationId: "installation",
      productVersion: "1.0.0",
      instanceId: "instance",
      pid: 123,
      processIdentity: "identity",
      nonce: "nonce"
    };
    const snapshot = {
      instanceId: "instance",
      revision: 1,
      state: "stopped",
      stopIntent: true
    };
    expect(controlHelloSchema.safeParse(hello).success).toBe(true);
    expect(
      controlHelloSchema.safeParse({ ...hello, protocolVersion: 2 }).success
    ).toBe(false);
    expect(controlHelloSchema.safeParse({ ...hello, pid: 0 }).success).toBe(
      false
    );
    expect(
      controlReplySchema.safeParse({ requestId: "1", ok: true, snapshot })
        .success
    ).toBe(true);
    expect(
      controlReplySchema.safeParse({
        requestId: "1",
        ok: false,
        code: "execute",
        snapshot
      }).success
    ).toBe(false);
    expect(
      controlReplySchema.safeParse({
        requestId: "1",
        ok: true,
        snapshot,
        extra: true
      }).success
    ).toBe(false);
  });
});
