// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentLookPicker,
  DEFAULT_AGENT_LOOK,
  ModelPicker,
  Pixelkin,
  V1Composer
} from "./visual.js";

describe("v1 presentation primitives", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it("draws the configured Pixelkin and sends look changes without mutating the original", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <>
          <Pixelkin look={DEFAULT_AGENT_LOOK} />
          <AgentLookPicker look={DEFAULT_AGENT_LOOK} onChange={onChange} />
        </>
      )
    );
    // happy-dom has no WebGL2, so the Kin falls back to its CSS body.
    expect(
      container.querySelector(
        `.v1-pixelkin-fallback[data-kin-shape="cube"][data-kin-colour="${DEFAULT_AGENT_LOOK.palette.base}"]`
      )
    ).not.toBeNull();
    await act(async () =>
      (
        container.querySelector(
          'button[aria-label="Mint"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_AGENT_LOOK,
      palette: { ...DEFAULT_AGENT_LOOK.palette, base: "#55cca3" }
    });
    expect(DEFAULT_AGENT_LOOK.palette.base).toBe("#7658e8");
  });
  it("offers only supplied models, limits provider changes, and changes reasoning by keyboard", async () => {
    const onChange = vi.fn(),
      onOpen = vi.fn();
    const providers = [
      {
        id: "a",
        label: "Client A",
        models: [
          {
            id: "model-a",
            label: "Model A",
            efforts: ["low", "medium", "high"],
            defaultEffort: "medium"
          }
        ]
      },
      {
        id: "b",
        label: "Client B",
        models: [{ id: "model-b", label: "Model B", efforts: ["low", "high"] }]
      }
    ];
    await act(async () =>
      root.render(
        <ModelPicker
          providers={providers}
          selection={{ providerId: "a", modelId: "model-a", effort: "medium" }}
          onChange={onChange}
          onOpen={onOpen}
          lockedProviderId="a"
        />
      )
    );
    await act(async () =>
      (container.querySelector(".v1-mode-button") as HTMLButtonElement).click()
    );
    expect(onOpen).toHaveBeenCalledOnce();
    const slider = container.querySelector('[role="slider"]') as HTMLDivElement;
    await act(async () =>
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      )
    );
    expect(onChange).toHaveBeenCalledWith({
      providerId: "a",
      modelId: "model-a",
      effort: "high"
    });
    await act(async () =>
      (
        container.querySelector(".v1-reason-top button") as HTMLButtonElement
      ).click()
    );
    expect(container.textContent).toContain("Model A");
    expect(container.textContent).not.toContain("Model B");
  });
  it("keeps text editable while send is pending, and routes stop separately", async () => {
    const onSend = vi.fn(),
      onStop = vi.fn(),
      onChange = vi.fn();
    await act(async () =>
      root.render(
        <V1Composer
          value="Hello"
          onChange={onChange}
          onSend={onSend}
          onStop={onStop}
          actionDisabled
        />
      )
    );
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).disabled
    ).toBe(false);
    expect(
      (container.querySelector("button[type=submit]") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    await act(async () =>
      root.render(
        <V1Composer
          value="Hello"
          onChange={onChange}
          onSend={onSend}
          onStop={onStop}
          busy
        />
      )
    );
    await act(async () =>
      (
        container.querySelector("button[aria-label=Stop]") as HTMLButtonElement
      ).click()
    );
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    await act(async () =>
      (
        container.querySelector("textarea") as HTMLTextAreaElement
      ).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });
  it("allows a supplied model without reasoning efforts", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <ModelPicker
          providers={[
            {
              id: "a",
              label: "Client A",
              models: [{ id: "plain", label: "Plain", efforts: [] }]
            }
          ]}
          selection={{ providerId: "a", modelId: "plain", effort: "" }}
          onChange={onChange}
        />
      )
    );
    await act(async () =>
      (container.querySelector(".v1-mode-button") as HTMLButtonElement).click()
    );
    await act(async () =>
      (
        container.querySelector(".v1-reason-top button") as HTMLButtonElement
      ).click()
    );
    const option = container.querySelector(
      ".v1-model-option"
    ) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledWith({
      providerId: "a",
      modelId: "plain",
      effort: ""
    });
  });
});
