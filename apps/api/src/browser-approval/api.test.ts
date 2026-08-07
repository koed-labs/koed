// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  approvalApiPath,
  approvalReturnPath,
  browserApprovalBasePath,
  workosLoginUrl
} from "./api.js";

describe("browser approval URL construction", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it.each([
    ["/high-risk/browser-activations/activation-1", ""],
    ["/device-enrollment/challenge-1", ""],
    ["/koed/high-risk/browser-activations/activation-1", "/koed"],
    ["/koed/device-enrollment/challenge-1", "/koed"]
  ])("derives the API base from %s", (pathname, expectedBase) => {
    window.history.replaceState({}, "", pathname);
    expect(browserApprovalBasePath()).toBe(expectedBase);
    expect(approvalApiPath("/me")).toBe(`${expectedBase}/me`);
  });

  it("keeps WorkOS authentication and return paths under the proxy prefix", () => {
    window.history.replaceState(
      {},
      "",
      "/koed/device-enrollment/challenge-1?source=desktop"
    );

    expect(approvalReturnPath()).toBe(
      "/koed/device-enrollment/challenge-1?source=desktop"
    );
    expect(workosLoginUrl()).toBe(
      `/koed/auth/workos/login?return_to=${encodeURIComponent(approvalReturnPath())}`
    );
  });
});
