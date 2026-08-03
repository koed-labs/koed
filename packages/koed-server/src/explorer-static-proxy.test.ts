import { describe, expect, it } from "vitest";
import {
  isExplorerApiProxyPath,
  resolveExplorerApiProxyTarget
} from "./explorer-static-proxy.js";

describe("Explorer static API proxy routing", () => {
  it.each([
    "/me",
    "/auth/login",
    "/auth/workos/callback?code=test",
    "/v1/capabilities",
    "/v1/high-risk/browser-activations/selector/decision"
  ])("proxies browser API path %s", (path) => {
    expect(isExplorerApiProxyPath(path)).toBe(true);
  });

  it.each(["/", "/assets/app.js", "/auth", "/v1", "/v10/example"])(
    "serves Explorer content for non-API path %s",
    (path) => {
      expect(isExplorerApiProxyPath(path)).toBe(false);
    }
  );

  it("keeps the configured API path prefix and request query", () => {
    expect(
      resolveExplorerApiProxyTarget(
        "/v1/capabilities?audience=authenticated",
        new URL("https://backend.example/koed/")
      ).toString()
    ).toBe(
      "https://backend.example/koed/v1/capabilities?audience=authenticated"
    );
  });

  it("ignores an absolute request target host", () => {
    expect(
      resolveExplorerApiProxyTarget(
        "https://attacker.example/v1/capabilities",
        new URL("https://backend.example/")
      ).toString()
    ).toBe("https://backend.example/v1/capabilities");
  });
});
