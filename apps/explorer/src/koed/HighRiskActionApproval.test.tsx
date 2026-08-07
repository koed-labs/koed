// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HighRiskBrowserActivation } from "./types";

const api = vi.hoisted(() => ({
  loadActivation: vi.fn(),
  loadProviders: vi.fn(),
  login: vi.fn(),
  decide: vi.fn()
}));

vi.mock("./api", () => ({
  apiBaseUrl: "http://localhost:3300",
  decideHighRiskBrowserActivation: api.decide,
  loadBrowserAuthProviders: api.loadProviders,
  loadHighRiskBrowserActivation: api.loadActivation,
  loginWithLocalSession: api.login
}));

import { HighRiskActionApproval } from "./HighRiskActionApproval";

const activation: HighRiskBrowserActivation = {
  status: {
    version: 1,
    actionGrant: { id: "f004a7ae-698e-48d1-a44e-c37bbda9448d" },
    selector: "953249fe-6002-4750-83e8-fe89268e35ac",
    approvalTier: "step_up",
    review: {
      version: 1,
      title: "Create a Team",
      description: "Create a new Team with its default Workspace and channel.",
      consequence: "A new Team will be created.",
      confirmLabel: "Create Team",
      details: []
    },
    state: "pending",
    activationPath:
      "/v1/high-risk/browser-activations/953249fe-6002-4750-83e8-fe89268e35ac",
    expiresAt: "2026-01-01T00:10:00.000Z"
  },
  confirmation: {
    action: "team.create",
    operationFamily: "admin",
    teamId: null,
    targetId: null
  }
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

describe("HighRiskActionApproval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.loadActivation.mockReset();
    api.loadProviders.mockReset();
    api.login.mockReset();
    api.decide.mockReset();
    vi.spyOn(window, "close").mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("reauthenticates locally before showing and approving the exact action", async () => {
    api.loadActivation
      .mockRejectedValueOnce(new Error("Session cookie required"))
      .mockResolvedValueOnce(activation);
    api.loadProviders.mockResolvedValue(["local"]);
    api.login.mockResolvedValue(undefined);
    api.decide.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state: "approved", activationPath: null }
    });

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
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
    await act(async () => {
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
    expect(container.textContent).toContain("Create a Team");
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Team")
    );
    await act(async () => approve!.click());
    await settle();

    expect(api.decide).toHaveBeenCalledWith(
      activation.status.selector,
      "approve"
    );
    expect(container.textContent).toContain(
      "Koed Desktop is retrieving the result"
    );
    expect(container.textContent).toContain("safely close this window");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers WorkOS reauthentication without exposing local credentials when it is the only provider", async () => {
    api.loadActivation.mockRejectedValue(new Error("Session cookie required"));
    api.loadProviders.mockResolvedValue(["workos"]);

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();

    expect(container.textContent).toContain("Sign in with WorkOS");
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("keeps an initial lookup failure open and lets the User retry", async () => {
    const openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {}
    });
    api.loadActivation
      .mockRejectedValueOnce(new Error("Status endpoint unavailable"))
      .mockResolvedValueOnce(activation);

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("no decision was submitted");
    expect(container.textContent).toContain("Retry action lookup");
    expect(window.close).not.toHaveBeenCalled();

    const retry = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry action lookup")
    );
    await act(async () => retry!.click());
    await settle();

    expect(api.loadActivation).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Create a Team");
    if (openerDescriptor) {
      Object.defineProperty(window, "opener", openerDescriptor);
    } else {
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null
      });
    }
  });

  it("requires reauthentication again when the session is no longer fresh", async () => {
    api.loadActivation.mockResolvedValue(activation);
    api.loadProviders.mockResolvedValue(["local"]);
    api.decide.mockRejectedValue(
      new Error("Fresh browser authentication is required")
    );

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Team")
    );
    await act(async () => approve!.click());
    await settle();

    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      "Fresh browser authentication is required"
    );
  });

  it("reconciles a committed decision when the POST response is lost", async () => {
    api.loadActivation.mockResolvedValueOnce(activation).mockResolvedValueOnce({
      ...activation,
      status: { ...activation.status, state: "approved", activationPath: null }
    });
    api.decide.mockRejectedValue(new Error("Network connection was lost"));

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Team")
    );
    await act(async () => approve!.click());
    await settle();

    expect(api.loadActivation).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      "Approved — Koed Desktop is retrieving the result"
    );
    expect(container.textContent).not.toContain("no decision");
  });

  it("keeps the window open while a lost decision response cannot be reconciled", async () => {
    const openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {}
    });
    api.loadActivation
      .mockResolvedValueOnce(activation)
      .mockRejectedValueOnce(new Error("Status endpoint unavailable"));
    api.decide.mockRejectedValue(new Error("Network connection was lost"));

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Team")
    );
    await act(async () => approve!.click());
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("Outcome unknown");
    expect(container.textContent).toContain("Check decision status");
    expect(window.close).not.toHaveBeenCalled();
    if (openerDescriptor) {
      Object.defineProperty(window, "opener", openerDescriptor);
    } else {
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null
      });
    }
  });

  it("fails closed when authoritative review details are missing", async () => {
    api.loadActivation.mockResolvedValue({
      ...activation,
      status: { ...activation.status, review: null },
      confirmation: {
        ...activation.confirmation,
        action: "internal.future_operation"
      }
    });

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();

    expect(container.textContent).toContain(
      "Sensitive Team action unavailable"
    );
    expect(container.textContent).toContain(
      "missing authoritative approval details"
    );
    expect(container.textContent).not.toContain("internal.future_operation");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it("fails closed when a browser activation is not Step-up", async () => {
    api.loadActivation.mockResolvedValue({
      ...activation,
      status: { ...activation.status, approvalTier: "native_review" }
    });

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();

    expect(container.textContent).toContain(
      "Sensitive Team action unavailable"
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it.each([
    ["approved", "Approved — Koed Desktop is retrieving the result"],
    ["consumed", "one-use approval was consumed and cannot be replayed"],
    ["denied", "Denied — no change was authorized"],
    ["canceled", "Canceled — no change was authorized"],
    ["revoked", "authority for this request was revoked"],
    ["expired", "return to Koed, and start the action again"]
  ] as const)("renders an inert %s terminal result", async (state, copy) => {
    api.loadActivation.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state, activationPath: null }
    });

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();

    expect(container.textContent).toContain(copy);
    expect(container.textContent?.toLowerCase()).toContain("close this window");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it("attempts to close a script-opened window after rendering the result", async () => {
    const openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {}
    });
    api.loadActivation.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state: "denied", activationPath: null }
    });

    await act(async () => {
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      );
    });
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain(
      "Denied — no change was authorized"
    );
    expect(window.close).toHaveBeenCalledOnce();
    if (openerDescriptor) {
      Object.defineProperty(window, "opener", openerDescriptor);
    } else {
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null
      });
    }
  });
});
