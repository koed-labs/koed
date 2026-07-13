import { describe, expect, it } from "vitest";
import {
  assertSecureHttpTransport,
  isLoopbackHostname
} from "./http-transport-security.js";

describe("HTTP transport security", () => {
  it("allows HTTPS endpoints", () => {
    expect(() =>
      assertSecureHttpTransport(new URL("https://team.example.test"))
    ).not.toThrow();
  });

  it.each([
    "http://localhost:3300",
    "http://127.0.0.1:3300",
    "http://[::1]:3300"
  ])("allows exact loopback HTTP endpoint %s", (value) => {
    expect(() => assertSecureHttpTransport(new URL(value))).not.toThrow();
  });

  it.each([
    "http://team.example.test",
    "http://10.0.0.12:3300",
    "http://host.docker.internal:3300",
    "http://localhost.example.test:3300",
    "http://127.0.0.2:3300"
  ])("rejects non-loopback HTTP endpoint %s", (value) => {
    expect(() =>
      assertSecureHttpTransport(new URL(value), "Upstream URL")
    ).toThrow("Upstream URL must use HTTPS unless it targets localhost");
  });

  it("recognizes only the explicit loopback hostnames", () => {
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("localhost.example.test")).toBe(false);
  });
});
