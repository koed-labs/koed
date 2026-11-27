import { describe, expect, it } from "vitest";
import { validateControlHello } from "./handshake.js";

const expected = {
  home: "/home/example",
  installationId: "install",
  productVersion: "1.0.0",
  instanceId: "instance",
  pid: 123,
  processIdentity: "identity",
  nonce: "nonce"
};
const hello = { protocolVersion: 1, ...expected };

describe("authenticated control hello", () => {
  it("accepts only matching context and connection-bound PID", () => {
    expect(
      validateControlHello(hello, expected, { pid: 123, uid: 501 })
    ).toEqual(hello);
    expect(() =>
      validateControlHello(hello, expected, { pid: 124, uid: 501 })
    ).toThrow(/peer/i);
  });
  it.each([
    "home",
    "installationId",
    "productVersion",
    "instanceId",
    "processIdentity",
    "nonce"
  ] as const)("rejects mismatched %s", (field) => {
    expect(() =>
      validateControlHello({ ...hello, [field]: "other" }, expected, {
        pid: 123,
        uid: 501
      })
    ).toThrow(/mismatch/i);
  });
  it("rejects incompatible protocol and extra input", () => {
    expect(() =>
      validateControlHello({ ...hello, protocolVersion: 2 }, expected, {
        pid: 123,
        uid: 501
      })
    ).toThrow();
    expect(() =>
      validateControlHello({ ...hello, extra: true }, expected, {
        pid: 123,
        uid: 501
      })
    ).toThrow();
  });
});
