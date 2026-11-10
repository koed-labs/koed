// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccelerationChoice,
  AccelerationSnapshot
} from "@koed-labs/server";
import {
  accelerationApiFixture,
  accelerationSnapshot
} from "../acceleration.fixture.js";
import { HardwareStep } from "./HardwareStep.js";
import { restoreOnboarding } from "./model.js";

describe("hardware onboarding", () => {
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
  const render = async (
    value = accelerationSnapshot(),
    draft?: AccelerationChoice
  ) => {
    const api = accelerationApiFixture(value);
    const apply = vi.spyOn(api, "apply");
    const inspect = vi.spyOn(api, "inspect");
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { acceleration: api }
    });
    const onContinue = vi.fn(),
      onChoice = vi.fn();
    await act(async () =>
      root.render(
        <HardwareStep
          draft={draft}
          onChoice={onChoice}
          onContinue={onContinue}
          onBack={() => {}}
        />
      )
    );
    return { apply, inspect, onContinue, onChoice };
  };
  const radio = (value: string) =>
    container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  const next = () =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Continue"
    )!;
  it("defaults fresh Linux to CPU, shows reviewed bytes, and only hands off on Continue", async () => {
    const result = await render();
    expect(radio("cpu").checked).toBe(true);
    expect(container.textContent).toContain("300 MB");
    expect(container.textContent).not.toContain("682 MB");
    expect(container.textContent).not.toContain(
      "Your embedding model runs on this device"
    );
    expect(result.apply).not.toHaveBeenCalled();
    expect(result.onContinue).not.toHaveBeenCalled();
    await act(async () => next().click());
    expect(result.onContinue).toHaveBeenCalledWith({
      preference: "cpu",
      installCuda: false,
      expectedRevision: "a".repeat(64)
    });
  });
  it("defaults a supported Mac to Metal without a CUDA download or an active-execution claim", async () => {
    const value = accelerationSnapshot();
    value.hardware = {
      ...value.hardware,
      backend: "metal",
      name: "Apple Silicon"
    };
    value.recommendedPreference = "auto";
    const result = await render(value);
    expect(radio("auto").checked).toBe(true);
    expect(container.textContent).toContain("Metal acceleration");
    expect(container.textContent).not.toContain("Currently using");
    expect(container.textContent).not.toContain("Additional download");
    await act(async () => next().click());
    expect(result.onContinue).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: false,
      expectedRevision: "a".repeat(64)
    });
  });
  it("captures CUDA opt-in only when the User selects that option", async () => {
    const result = await render();
    expect(result.onChoice).not.toHaveBeenCalled();
    await act(async () => radio("auto").click());
    expect(result.onChoice).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: true,
      expectedRevision: "a".repeat(64)
    });
    expect(result.apply).not.toHaveBeenCalled();
  });
  it("requires a new CUDA choice after partial setup invalidates an unsaved draft", async () => {
    const value = accelerationSnapshot();
    value.recommendedPreference = "auto";
    value.cuda.downloadBytes = 0;
    const result = await render(value, {
      preference: "auto",
      installCuda: true,
      expectedRevision: "b".repeat(64)
    });
    expect(radio("cpu").checked).toBe(true);
    await act(async () => next().click());
    expect(result.onContinue).toHaveBeenCalledWith({
      preference: "cpu",
      installCuda: false,
      expectedRevision: value.revision
    });
    await act(async () => radio("auto").click());
    expect(result.onChoice).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: true,
      expectedRevision: value.revision
    });
  });
  it.each(["installed", "saved"] as const)(
    "retains an existing %s automatic choice",
    async (existing) => {
      const value = accelerationSnapshot();
      value.recommendedPreference = "auto";
      value.preference = "auto";
      if (existing === "installed") value.cuda.state = "installed";
      else value.source = "saved";
      await render(value);
      expect(radio("auto").checked).toBe(true);
    }
  );
  it.each(["unknown", "unavailable", "unsupported"] as const)(
    "keeps CPU available when detection is %s",
    async (state) => {
      const value = accelerationSnapshot();
      value.hardware = {
        ...value.hardware,
        state,
        backend: null,
        reason: "Detection could not finish."
      };
      await render(value);
      expect(radio("cpu").disabled).toBe(false);
      expect(next().disabled).toBe(false);
      expect(container.textContent).toContain("Detection could not finish.");
    }
  );
  it("does not replay a stale draft and preserves client progress in draft restoration", async () => {
    const draft = restoreOnboarding({
      version: 2,
      step: "hardware",
      selected: ["codex"],
      selectionInitialized: true,
      processing: {
        preference: "auto",
        installCuda: true,
        expectedRevision: "b".repeat(64)
      }
    });
    expect(draft.selected).toEqual(["codex"]);
    expect(draft.step).toBe("hardware");
    const result = await render(accelerationSnapshot(), draft.processing);
    expect(radio("cpu").checked).toBe(true);
    expect(result.apply).not.toHaveBeenCalled();
    expect(result.onContinue).not.toHaveBeenCalled();
    expect(container.textContent).toContain("configuration changed");
  });
  it.each(["environment", "external"] as const)(
    "preserves %s-managed processing when continuing",
    async (source) => {
      const value: AccelerationSnapshot = {
        ...accelerationSnapshot(),
        source,
        readOnlyReason: "The Operator manages processing."
      };
      const result = await render(value);
      expect(container.querySelector("fieldset")?.disabled).toBe(true);
      await act(async () => next().click());
      expect(result.onContinue).toHaveBeenCalledWith(undefined);
      expect(result.apply).not.toHaveBeenCalled();
    }
  );
});
