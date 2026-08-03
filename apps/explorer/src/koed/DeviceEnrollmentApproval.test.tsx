// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceEnrollmentChallenge } from "./types";

const api = vi.hoisted(() => ({
  loadChallenge: vi.fn(),
  loadProviders: vi.fn(),
  requireSession: vi.fn(),
  login: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn()
}));

vi.mock("./api", () => ({
  apiBaseUrl: "http://localhost:3300",
  approveDeviceEnrollmentChallenge: api.approve,
  denyDeviceEnrollmentChallenge: api.deny,
  loadBrowserAuthProviders: api.loadProviders,
  loadDeviceEnrollmentChallenge: api.loadChallenge,
  loginWithLocalSession: api.login,
  requireBrowserSession: api.requireSession
}));

import { DeviceEnrollmentApproval } from "./DeviceEnrollmentApproval";

const challenge: DeviceEnrollmentChallenge = {
  id: "challenge-1",
  status: "pending",
  upstreamBackendId: "team-vps",
  deviceInstanceId: "device-1",
  deviceLabel: "Mark's laptop",
  requestedOperationFamilies: ["team_workspace_read"],
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:10:00.000Z",
  approvedAt: null,
  deniedAt: null
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const enterValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("DeviceEnrollmentApproval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.loadChallenge.mockReset();
    api.loadProviders.mockReset();
    api.requireSession.mockReset();
    api.login.mockReset();
    api.approve.mockReset();
    api.deny.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("establishes a local browser session and reloads the challenge", async () => {
    api.loadChallenge.mockResolvedValue(challenge);
    api.requireSession
      .mockRejectedValueOnce(new Error("Session cookie required"))
      .mockResolvedValueOnce(undefined);
    api.loadProviders.mockResolvedValue(["local"]);
    api.login.mockResolvedValue(undefined);

    await act(async () => {
      root.render(<DeviceEnrollmentApproval challengeId="challenge-1" />);
    });
    await settle();

    const email = container.querySelector<HTMLInputElement>(
      'input[type="email"]'
    );
    const password = container.querySelector<HTMLInputElement>(
      'input[type="password"]'
    );
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    await act(async () => {
      enterValue(email!, "owner@example.test");
      enterValue(password!, "correct horse battery staple");
    });
    const form = container.querySelector("form");
    await act(async () => {
      form!.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true })
      );
    });
    await settle();

    expect(api.login).toHaveBeenCalledWith(
      "owner@example.test",
      "correct horse battery staple"
    );
    expect(api.loadChallenge).toHaveBeenCalledTimes(2);
    expect(api.requireSession).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Approve device");
  });

  it("returns to sign in if the session expires during approval", async () => {
    api.loadChallenge.mockResolvedValue(challenge);
    api.requireSession.mockResolvedValue(undefined);
    api.loadProviders.mockResolvedValue(["local"]);
    api.approve.mockRejectedValue(new Error("Session cookie required"));

    await act(async () => {
      root.render(<DeviceEnrollmentApproval challengeId="challenge-1" />);
    });
    await settle();
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Approve device")
    );
    await act(async () => approve!.click());
    await settle();

    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Session cookie required");
  });
});
