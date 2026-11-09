// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccelerationSnapshot,
  DesktopAccelerationState,
  DesktopAccelerationApi
} from "@koed-labs/server";
import { AccelerationSettings } from "./AccelerationSettings.js";

const snapshot = (): AccelerationSnapshot => ({
  observedAt: "2026-11-09T00:00:00Z",
  revision: "a".repeat(64),
  configurationRevision: "a".repeat(64),
  runtimeEpoch: "stopped",
  preference: "cpu",
  recommendedPreference: "cpu",
  effectivePolicy: "cpu",
  source: "saved",
  readOnlyReason: null,
  hardware: {
    state: "available",
    backend: "cuda",
    name: "NVIDIA GPU",
    memoryBytes: 8e9,
    reason: "Detected",
    verification: "host"
  },
  cuda: {
    validation: "unknown",
    state: "installed",
    selectionId: "b".repeat(64),
    canInstall: true,
    downloadBytes: 0,
    requiredFreeBytes: 128e6,
    availableFreeBytes: 10e9,
    reason: "Installed"
  },
  model: {
    key: "qwen3-0.6b",
    label: "Qwen3 Embedding · 0.6B",
    filename: "embedding.gguf",
    present: true
  },
  embedding: { state: "stopped", backend: null, fallbackReason: null },
  privacy: { state: "absent", provider: null, fallbackReason: null }
});
describe("local processing Settings", () => {
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
    value = snapshot(),
    operation: DesktopAccelerationState["operation"] = null
  ) => {
    const api: DesktopAccelerationApi = {
      inspect: vi.fn(async () => ({ snapshot: value, operation })),
      apply: vi.fn(async () => ({ snapshot: value, operation: null })),
      cancel: vi.fn(async () => ({ snapshot: value, operation: null }))
    };
    await act(async () => root.render(<AccelerationSettings api={api} />));
    return api;
  };
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (node) => node.textContent === label
    )!;
  const processing = () =>
    container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Local AI processing"]'
    )!;
  const option = (label: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent?.trim() === label
    )!;
  const chooseGpu = async () => {
    await act(async () => processing().click());
    await act(async () => option("GPU · CUDA").click());
  };
  it("shows the model and stopped state without claiming installed CUDA is active", async () => {
    const api = await render();
    expect(container.textContent).toContain("Qwen3 Embedding · 0.6B");
    expect(container.textContent).toContain("Services stopped");
    expect(container.textContent).not.toContain("Using CUDA");
    expect(
      container.querySelector(".acceleration-privacy")?.textContent
    ).toContain("Not installed");
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("only changes policy after explicit Apply and does not request another download", async () => {
    const api = await render();
    await chooseGpu();
    expect(api.apply).not.toHaveBeenCalled();
    await act(async () => button("Apply").click());
    expect(api.apply).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: false,
      expectedRevision: "a".repeat(64)
    });
  });
  it("keeps managed settings read-only without exposing configuration bookkeeping", async () => {
    const api = await render({
      ...snapshot(),
      source: "environment",
      effectivePolicy: "cuda",
      readOnlyReason: "The Operator controls processing."
    });
    expect(processing().disabled).toBe(true);
    expect(button("Apply").disabled).toBe(true);
    expect(container.textContent).toContain(
      "The Operator controls processing."
    );
    expect(container.textContent).not.toContain("Saved preference:");
    expect(container.textContent).not.toContain("Effective setting:");
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("offers explicit CUDA installation and does not infer Privacy's provider", async () => {
    const value = snapshot();
    value.cuda.state = "missing";
    value.embedding = {
      state: "ready",
      backend: "cpu",
      fallbackReason: "cuda_device_unavailable"
    };
    value.privacy = {
      state: "ready",
      provider: "coreml",
      fallbackReason: null
    };
    await render(value);
    await act(async () => processing().click());
    expect(option("GPU · CUDA").getAttribute("aria-disabled")).not.toBe("true");
    expect(container.textContent).toContain("Using CPU · fallback");
    expect(
      container.querySelector(".acceleration-privacy")?.textContent
    ).toContain("Core ML");
  });
  it("only requests a CUDA installation after selecting GPU and applying", async () => {
    const value = snapshot();
    value.cuda.state = "missing";
    value.cuda.downloadBytes = 300 * 1_048_576;
    const api = await render(value);
    expect(container.querySelector(".acceleration-download")).toBeNull();
    await chooseGpu();
    expect(container.textContent).toContain("300 MB");
    expect(container.textContent).toContain("123 MB free disk space required");
    expect(button("Apply").getAttribute("aria-label")).toBe(
      "Apply and install CUDA"
    );
    expect(api.apply).not.toHaveBeenCalled();
    await act(async () => button("Apply").click());
    expect(api.apply).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: true,
      expectedRevision: "a".repeat(64)
    });
  });
  it("does not present the previous backend or fallback as current during a processing change", async () => {
    const value = snapshot();
    value.embedding = {
      state: "ready",
      backend: "cpu",
      fallbackReason: "cuda_device_unavailable"
    };
    value.privacy = {
      state: "ready",
      provider: "coreml",
      fallbackReason: null
    };
    const api = await render(value, {
      id: "pending-install",
      sequence: 2,
      state: "running",
      phase: "downloading",
      cancellable: true,
      completedBytes: 10,
      totalBytes: 100,
      message: "Downloading the reviewed runtime…"
    });
    expect(container.textContent).toContain("Applying change…");
    expect(container.textContent).not.toContain("Using CPU");
    expect(container.textContent).not.toContain("cuda device unavailable");
    expect(
      container.querySelector(".acceleration-privacy")?.textContent
    ).toContain("Updating…");
    expect(button("Apply")).toBeUndefined();
    expect(
      container.querySelector(".acceleration-footer-message")?.textContent
    ).toBe("Downloading the reviewed runtime…");
    expect(container.querySelector(".acceleration-progress")).toBeNull();
    expect(container.querySelector("progress")).toBeNull();
    await act(async () => button("Cancel").click());
    expect(api.cancel).toHaveBeenCalledWith("pending-install");
  });
  it("uses the existing footer for CPU fallback instead of adding a warning row", async () => {
    const value = snapshot();
    value.preference = "auto";
    value.embedding = {
      state: "ready",
      backend: "cpu",
      fallbackReason: "gpu_unavailable"
    };
    await render(value);
    expect(
      container.querySelector(".acceleration-footer-message")?.textContent
    ).toBe("Your GPU is unavailable. CPU keeps your memories searchable.");
    expect(
      container
        .querySelector(".acceleration-footer-reserve")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
    expect(container.querySelector(".acceleration-progress")).toBeNull();
    expect(container.querySelector(".acceleration-download")).toBeNull();
  });
  it("keeps GPU unavailable when the runtime cannot be installed", async () => {
    const value = snapshot();
    value.cuda.state = "missing";
    value.cuda.canInstall = false;
    value.cuda.reason = "Not enough disk space.";
    const api = await render(value);
    await act(async () => processing().click());
    expect(option("GPU · CUDA").getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Not enough disk space.");
    expect(button("Apply").disabled).toBe(true);
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("keeps an installed CUDA runtime usable without requesting another download", async () => {
    const value = snapshot();
    value.cuda.state = "outdated";
    const api = await render(value);
    await chooseGpu();
    expect(container.querySelector(".acceleration-download")).toBeNull();
    expect(
      container.querySelector(".acceleration-footer-message")?.textContent
    ).toBe("Applies when services next start.");
    await act(async () => button("Apply").click());
    expect(api.apply).toHaveBeenCalledWith({
      preference: "auto",
      installCuda: false,
      expectedRevision: value.revision
    });
  });
  it("shows an interrupted operation and can refresh its status without applying", async () => {
    const api = await render(snapshot(), {
      id: "interrupted",
      sequence: 2,
      state: "interrupted",
      phase: "starting",
      cancellable: false,
      completedBytes: null,
      totalBytes: null,
      message: "The processing change was interrupted."
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "interrupted"
    );
    await act(async () => button("Check again").click());
    expect(api.inspect).toHaveBeenLastCalledWith(true);
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("shows the current backend without a restored completion notice", async () => {
    const value = snapshot();
    value.embedding = {
      state: "ready",
      backend: "metal",
      fallbackReason: null
    };
    const message =
      "The previous processing change finished. Current configuration and runtime status are shown below.";
    await render(value, {
      id: "completed",
      sequence: 2,
      state: "complete",
      phase: "checking",
      cancellable: false,
      completedBytes: null,
      totalBytes: null,
      message
    });
    expect(container.textContent).toContain("Using Metal");
    expect(container.textContent).not.toContain(message);
    expect(
      container.querySelector(".acceleration-footer-message")?.textContent
    ).toBe("");
  });
  it("keeps stopped-runtime recovery feedback short while preserving the operation detail", async () => {
    const message =
      "A process still references this native runtime or Postgres data directory. Run koed stop before retrying. Stale or unreadable locks require stopped-runtime Operator recovery.";
    const operation: DesktopAccelerationState["operation"] = {
      id: "failed-stop",
      sequence: 2,
      state: "failed",
      phase: "saving",
      cancellable: false,
      completedBytes: null,
      totalBytes: null,
      message
    };
    await render(snapshot(), operation);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Koed couldn’t stop safely; restart services and try again."
    );
    expect(container.textContent).not.toContain("Postgres data directory");
    expect(operation.message).toBe(message);
  });
  it("replaces the starting label when service health becomes ready without a preference change", async () => {
    vi.useFakeTimers();
    try {
      const value = snapshot();
      value.embedding = {
        state: "starting",
        backend: null,
        fallbackReason: null
      };
      const api = await render(value);
      expect(container.textContent).toContain("Services starting");
      value.embedding = {
        state: "ready",
        backend: "metal",
        fallbackReason: null
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(container.textContent).toContain("Using Metal");
      expect(container.textContent).not.toContain("Services starting");
      expect(api.apply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not expose a GPU option on a CPU-only device", async () => {
    const value = snapshot();
    value.hardware = {
      ...value.hardware,
      state: "unsupported",
      backend: null,
      reason: "CPU processing is ready to use."
    };
    value.cuda.state = "not-applicable";
    await render(value);
    await act(async () => processing().click());
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(button("Apply").disabled).toBe(true);
    expect(container.textContent).toContain("CPU processing is ready to use.");
  });
});
