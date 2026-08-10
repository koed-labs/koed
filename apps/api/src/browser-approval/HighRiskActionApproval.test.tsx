// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HighRiskBrowserActivation } from "../high-risk/schemas.js";

const api = vi.hoisted(() => ({
  decide: vi.fn(),
  load: vi.fn(),
  providers: vi.fn(),
  login: vi.fn()
}));

vi.mock("./api.js", async (original) => ({
  ...(await original<typeof import("./api.js")>()),
  decideHighRiskBrowserActivation: api.decide,
  loadHighRiskBrowserActivation: api.load,
  loadBrowserAuthProviders: api.providers,
  loginWithLocalSession: api.login
}));

import { HighRiskActionApproval } from "./HighRiskActionApproval.js";
import { BrowserApprovalRequestError } from "./api.js";

const activation: HighRiskBrowserActivation = {
  status: {
    version: 1,
    actionGrant: { id: "f004a7ae-698e-48d1-a44e-c37bbda9448d" },
    selector: "953249fe-6002-4750-83e8-fe89268e35ac",
    approvalTier: "step_up",
    review: {
      version: 1,
      title: "Create a Team",
      description: "Create a new Team.",
      consequence: "A Team will be created.",
      confirmLabel: "Create Team",
      details: [{ label: "Team name", value: "Product" }]
    },
    state: "pending",
    activationPath:
      "/high-risk/browser-activations/953249fe-6002-4750-83e8-fe89268e35ac",
    expiresAt: "2026-01-01T00:10:00.000Z"
  },
  confirmation: {
    action: "team.create",
    operationFamily: "admin",
    teamId: null,
    targetId: null
  }
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

describe("HighRiskActionApproval", () => {
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
    vi.restoreAllMocks();
  });

  it("shows authoritative review copy and records one explicit decision", async () => {
    api.load.mockResolvedValue(activation);
    api.decide.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state: "approved", activationPath: null }
    });
    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
    );
    await settle();
    expect(container.textContent).toContain("Team nameProduct");
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create Team"
    )!;
    await act(async () => approve.click());
    await settle();
    expect(api.decide).toHaveBeenCalledWith(
      activation.status.selector,
      "approve"
    );
    expect(container.textContent).toContain(
      "Koed Desktop is retrieving the result"
    );
    expect(container.querySelector("[role=status]")).toBe(
      document.activeElement
    );
  });

  it("fails closed without a Step-up tier and authoritative review", async () => {
    api.load.mockResolvedValue({
      ...activation,
      status: {
        ...activation.status,
        approvalTier: "native_review",
        review: null
      }
    });
    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
    );
    await settle();
    expect(container.textContent).toContain(
      "missing authoritative approval details"
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it("reauthenticates locally before showing the exact action", async () => {
    api.load
      .mockRejectedValueOnce(
        new BrowserApprovalRequestError("Session cookie required", 401)
      )
      .mockResolvedValueOnce(activation);
    api.providers.mockResolvedValue(["local"]);
    api.login.mockResolvedValue(undefined);
    api.decide.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state: "approved", activationPath: null }
    });
    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
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
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create Team"
    )!;
    await act(async () => approve.click());
    await settle();
    expect(api.decide).toHaveBeenCalledWith(
      activation.status.selector,
      "approve"
    );
    expect(container.textContent).toContain(
      "Koed Desktop is retrieving the result"
    );
  });

  it("offers WorkOS with an exact relative approval return path", async () => {
    window.history.replaceState(
      {},
      "",
      `/koed/high-risk/browser-activations/${activation.status.selector}`
    );
    api.load.mockRejectedValue(
      new BrowserApprovalRequestError("Session cookie required", 401)
    );
    api.providers.mockResolvedValue(["workos"]);
    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
    );
    await settle();

    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toContain("Sign in with WorkOS");
    expect(link.getAttribute("href")).toBe(
      `/koed/auth/workos/login?return_to=${encodeURIComponent(`/koed/high-risk/browser-activations/${activation.status.selector}`)}`
    );
    expect(container.querySelector("input")).toBeNull();
  });

  it.each(["consumed", "denied", "revoked", "canceled", "expired"] as const)(
    "renders an inert %s terminal result",
    async (state) => {
      api.load.mockResolvedValue({
        ...activation,
        status: { ...activation.status, state, activationPath: null }
      });
      await act(async () =>
        root.render(
          <HighRiskActionApproval selector={activation.status.selector} />
        )
      );
      await settle();

      expect(container.querySelectorAll("button")).toHaveLength(0);
      expect(container.querySelector("[role=status]")).toBe(
        document.activeElement
      );
      expect(api.decide).not.toHaveBeenCalled();
    }
  );

  it("closes a script-opened browser handoff after rendering a terminal result", async () => {
    const openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {}
    });
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    api.load.mockResolvedValue({
      ...activation,
      status: { ...activation.status, state: "denied", activationPath: null }
    });

    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
    );
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(container.textContent).toContain("safely close this page");
    expect(close).toHaveBeenCalledOnce();
    if (openerDescriptor) {
      Object.defineProperty(window, "opener", openerDescriptor);
    } else {
      Object.defineProperty(window, "opener", {
        configurable: true,
        value: null
      });
    }
  });

  it("keeps an unreconciled decision open for an authoritative retry", async () => {
    api.load
      .mockResolvedValueOnce(activation)
      .mockRejectedValueOnce(new Error("offline"));
    api.decide.mockRejectedValue(new Error("response lost"));
    await act(async () =>
      root.render(
        <HighRiskActionApproval selector={activation.status.selector} />
      )
    );
    await settle();
    const approve = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create Team"
    )!;
    await act(async () => approve.click());
    await settle();
    expect(container.textContent).toContain("Outcome unknown");
    expect(container.textContent).toContain("Check decision status");
  });
});
