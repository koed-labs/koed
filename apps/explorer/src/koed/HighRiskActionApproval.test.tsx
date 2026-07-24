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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
      "The enrolled device may perform this exact action once."
    );
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

  it("does not render an unrecognized internal action identifier", async () => {
    api.loadActivation.mockResolvedValue({
      ...activation,
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

    expect(container.textContent).toContain("Approve a sensitive Team action");
    expect(container.textContent).not.toContain("internal.future_operation");
  });
});
