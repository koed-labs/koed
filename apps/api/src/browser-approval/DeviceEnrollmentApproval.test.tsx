// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicDeviceEnrollmentChallenge } from "../local-edge/schemas.js";

const api = vi.hoisted(() => ({
  load: vi.fn(),
  session: vi.fn(),
  decide: vi.fn(),
  providers: vi.fn(),
  login: vi.fn()
}));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof import("./api.js")>()),
  loadDeviceEnrollmentChallenge: api.load,
  requireBrowserSession: api.session,
  decideDeviceEnrollmentChallenge: api.decide,
  loadBrowserAuthProviders: api.providers,
  loginWithLocalSession: api.login
}));
import { DeviceEnrollmentApproval } from "./DeviceEnrollmentApproval.js";
import { BrowserApprovalRequestError } from "./api.js";

const challenge: PublicDeviceEnrollmentChallenge = {
  id: "953249fe-6002-4750-83e8-fe89268e35ac",
  status: "pending",
  upstreamBackendId: "team-vps",
  deviceInstanceId: "device-1",
  deviceLabel: "Local laptop",
  requestedOperationFamilies: [
    "personal_memory_read",
    "personal_collaboration_read",
    "personal_collaboration_write",
    "team_workspace_read",
    "team_chat_read",
    "team_chat_write",
    "share_grant_management",
    "action_grant",
    "capture_writes",
    "sync",
    "managed_execution",
    "future_access_family"
  ],
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:10:00.000Z",
  approvedAt: null,
  deniedAt: null
};

const settle = async () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

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
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("labels every access family and supports explicit denial", async () => {
    api.load.mockResolvedValue(challenge);
    api.session.mockResolvedValue(undefined);
    api.decide.mockResolvedValue({
      ...challenge,
      status: "denied",
      deniedAt: "2026-01-01T00:01:00.000Z"
    });
    await act(async () =>
      root.render(<DeviceEnrollmentApproval challengeId={challenge.id} />)
    );
    await settle();
    for (const label of [
      "Personal Memory recall",
      "Personal collaboration read access",
      "Personal collaboration write access",
      "Team Workspace recall",
      "Team chat read access",
      "Team chat write access",
      "Share Grant management",
      "Browser-confirmed actions",
      "Capture writes",
      "Sync",
      "Managed Conversation execution",
      "Future access family"
    ]) {
      expect(container.textContent).toContain(label);
    }
    const deny = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Deny"
    )!;
    await act(async () => deny.click());
    await settle();
    expect(api.decide).toHaveBeenCalledWith(challenge.id, "deny");
    expect(container.textContent).toContain(
      "challenge can no longer be exchanged"
    );
    expect(container.querySelector("[role=status]")).toBe(
      document.activeElement
    );
  });

  it("reauthenticates locally before approving enrollment", async () => {
    api.load.mockResolvedValue(challenge);
    api.session
      .mockRejectedValueOnce(
        new BrowserApprovalRequestError("Session cookie required", 401)
      )
      .mockResolvedValueOnce(undefined);
    api.providers.mockResolvedValue(["local"]);
    api.login.mockResolvedValue(undefined);
    api.decide.mockResolvedValue({
      ...challenge,
      status: "approved",
      approvedAt: "2026-01-01T00:01:00.000Z"
    });
    await act(async () =>
      root.render(<DeviceEnrollmentApproval challengeId={challenge.id} />)
    );
    await settle();

    await act(async () => {
      enterValue(
        container.querySelector<HTMLInputElement>('input[type="email"]')!,
        "owner@example.test"
      );
      enterValue(
        container.querySelector<HTMLInputElement>('input[type="password"]')!,
        "correct horse battery staple"
      );
      container
        .querySelector("form")!
        .dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true })
        );
    });
    await settle();

    expect(api.login).toHaveBeenCalledWith(
      "owner@example.test",
      "correct horse battery staple"
    );
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve device"
    )!;
    await act(async () => approve.click());
    await settle();
    expect(api.decide).toHaveBeenCalledWith(challenge.id, "approve");
    expect(container.textContent).toContain("local device is approved");
    expect(container.querySelector("[role=status]")).toBe(
      document.activeElement
    );
  });

  it("renders expired enrollment as an inert terminal state", async () => {
    api.load.mockResolvedValue({ ...challenge, status: "expired" });
    await act(async () =>
      root.render(<DeviceEnrollmentApproval challengeId={challenge.id} />)
    );
    await settle();

    expect(container.textContent).toContain("enrollment request expired");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.session).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
    expect(container.querySelector("[role=status]")).toBe(
      document.activeElement
    );
  });

  it("returns to sign-in when the session expires during approval", async () => {
    api.load.mockResolvedValue(challenge);
    api.session.mockResolvedValue(undefined);
    api.decide.mockRejectedValue(
      new BrowserApprovalRequestError("Session cookie required", 401)
    );
    api.providers.mockResolvedValue(["local"]);
    await act(async () =>
      root.render(<DeviceEnrollmentApproval challengeId={challenge.id} />)
    );
    await settle();

    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve device"
    )!;
    await act(async () => approve.click());
    await settle();

    expect(container.textContent).toContain("Sign in with a browser session");
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
