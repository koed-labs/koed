import { describe, expect, it } from "vitest";
import { resolveBrowserApiBaseUrl } from "./api-base-url";

describe("resolveBrowserApiBaseUrl", () => {
  it("uses same origin when a remote Explorer bundle contains a loopback default", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300",
        "https://api.koed.ai/device-enrollment/challenge-id"
      )
    ).toBe("https://api.koed.ai");
  });

  it("preserves a reverse-proxy path prefix for remote enrollment", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300",
        "https://host.example/koed/device-enrollment/challenge-id"
      )
    ).toBe("https://host.example/koed");
  });

  it("preserves loopback configuration for local Explorer", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300/",
        "http://localhost:5174/device-enrollment/challenge-id"
      )
    ).toBe("http://localhost:3300");
  });

  it("preserves the Desktop API URL under the koed-app protocol", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300",
        "koed-app://app/index.html?apiUrl=http%3A%2F%2Flocalhost%3A3300"
      )
    ).toBe("http://localhost:3300");
  });

  it("preserves an explicit non-loopback API URL", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "https://memory.example.test/api/",
        "https://explorer.example.test/device-enrollment/challenge-id"
      )
    ).toBe("https://memory.example.test/api");
  });
});
