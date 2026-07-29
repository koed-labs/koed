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

  it("preserves a reverse-proxy path prefix for high-risk confirmation", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300",
        "https://host.example/koed/high-risk/browser-activations/selector-id"
      )
    ).toBe("https://host.example/koed");
  });

  it("uses the local Explorer origin for browser confirmation flows", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300/",
        "http://localhost:5174/device-enrollment/challenge-id"
      )
    ).toBe("http://localhost:5174");
  });

  it("preserves loopback configuration outside browser confirmation flows", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "http://localhost:3300/",
        "http://localhost:5174/projects"
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

  it("keeps browser confirmation same-origin with an explicit API URL", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "https://memory.example.test/api/",
        "https://explorer.example.test/device-enrollment/challenge-id"
      )
    ).toBe("https://explorer.example.test");
  });

  it("preserves an explicit non-loopback API URL on normal Explorer pages", () => {
    expect(
      resolveBrowserApiBaseUrl(
        "https://memory.example.test/api/",
        "https://explorer.example.test/projects"
      )
    ).toBe("https://memory.example.test/api");
  });
});
