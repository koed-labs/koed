import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { ClassificationError } from "./errors.js";
import { createPrivacyService } from "./server.js";
import { DeterministicPrivacyRuntime } from "./runtime.js";
import { SupervisedPrivacyRuntime } from "./supervised-runtime.js";

class FakeRuntime extends DeterministicPrivacyRuntime {
  ready = false;
  disposed = false;
  failure: "none" | "exit" | "cancel" = "none";
  loadFails = false;
  parityFails = false;
  beforeDispose?: () => Promise<void>;
  onClassify?: () => void;
  constructor(readonly onUnavailable: () => void) {
    super();
  }
  async load() {
    if (this.loadFails) throw new Error("synthetic native failure");
    this.ready = true;
  }
  override isReady() {
    return this.ready;
  }
  fail() {
    this.ready = false;
    this.onUnavailable();
  }
  override async classify(text: string, signal?: AbortSignal) {
    this.onClassify?.();
    if (this.failure === "cancel") {
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true })
      );
      this.fail();
      signal!.throwIfAborted();
    }
    if (this.failure === "exit") {
      this.fail();
      throw new ClassificationError("synthetic worker exit");
    }
    const raw = await super.classify(text);
    return this.parityFails
      ? { ...raw, decodedText: "invalid synthetic output" }
      : raw;
  }
  async dispose() {
    await this.beforeDispose?.();
    this.disposed = true;
    this.ready = false;
  }
}

const request = (signal?: AbortSignal) =>
  new Request("http://privacy/v1/classify", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-koed-privacy-token": "synthetic"
    },
    body: JSON.stringify({
      schemaVersion: 1,
      inputContractVersion: "koed-privacy-classification-v1",
      fields: [
        { path: "/same", text: "Synthetic first field" },
        { path: "/later", text: "Synthetic undispatched field" }
      ]
    })
  });
const config = resolveConfig({
  KOED_PRIVACY_TRANSFORMERS_CACHE: "/synthetic",
  PRIVACY_SERVICE_TOKEN: "synthetic"
});

describe("supervised Privacy recovery", () => {
  it("fails the complete request closed, retires capacity, validates replacement and rejects retired callbacks", async () => {
    const children: FakeRuntime[] = [];
    let release!: () => void;
    const retired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new SupervisedPrivacyRuntime(
      (onUnavailable) => {
        const child = new FakeRuntime(onUnavailable);
        children.push(child);
        return child;
      },
      { wait: async () => {} }
    );
    await runtime.load();
    children[0]!.beforeDispose = () => retired;
    children[0]!.failure = "exit";
    const service = createPrivacyService(config, runtime);
    const response = await service.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("fields");
    expect(runtime.isReady()).toBe(false);
    expect(runtime.availability()).toBe("recovering");
    const recoveringHealth = await service.handle(
      new Request("http://privacy/health")
    );
    expect(recoveringHealth.status).toBe(503);
    expect(await recoveringHealth.json()).toMatchObject({
      runtime: { inferenceState: "recovering" }
    });
    expect(children).toHaveLength(1);
    expect((await service.handle(request())).status).toBe(503);
    release();
    await vi.waitFor(() => expect(runtime.isReady()).toBe(true));
    expect(children[0]!.disposed).toBe(true);
    expect(children).toHaveLength(2);
    children[0]!.fail();
    expect(runtime.isReady()).toBe(true);
    expect((await service.handle(request())).status).toBe(200);
    await runtime.dispose();
    expect(children.every((child) => child.disposed)).toBe(true);
  });

  it("bounds restart attempts and refuses parity mismatches before accepting work", async () => {
    const children: FakeRuntime[] = [];
    const waits: number[] = [];
    const runtime = new SupervisedPrivacyRuntime(
      (onUnavailable) => {
        const child = new FakeRuntime(onUnavailable);
        child.parityFails = children.length === 1;
        child.loadFails = children.length > 1;
        children.push(child);
        return child;
      },
      {
        wait: async (ms) => {
          waits.push(ms);
        }
      }
    );
    await runtime.load();
    children[0]!.fail();
    await vi.waitFor(() => expect(runtime.availability()).toBe("unavailable"));
    expect(waits).toEqual([250, 1000, 5000]);
    expect(children).toHaveLength(4);
    expect(runtime.isReady()).toBe(false);
    await expect(runtime.classify("Synthetic request")).rejects.toThrow(
      "capacity unavailable"
    );
    expect(children).toHaveLength(4);
    await runtime.dispose();
  });

  it("cancels without partial success and restores capacity for a subsequent authenticated request", async () => {
    const children: FakeRuntime[] = [];
    const runtime = new SupervisedPrivacyRuntime(
      (onUnavailable) => {
        const child = new FakeRuntime(onUnavailable);
        children.push(child);
        return child;
      },
      { wait: async () => {} }
    );
    await runtime.load();
    children[0]!.failure = "cancel";
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    children[0]!.onClassify = entered;
    const service = createPrivacyService(config, runtime);
    const cancellation = new AbortController();
    const response = service.handle(request(cancellation.signal));
    await dispatched;
    cancellation.abort();
    expect((await response).status).toBe(499);
    await vi.waitFor(() => expect(runtime.isReady()).toBe(true));
    expect(children).toHaveLength(2);
    expect((await service.handle(request())).status).toBe(200);
    await runtime.dispose();
  });

  it("cancels backoff during shutdown without creating an orphan replacement", async () => {
    const children: FakeRuntime[] = [];
    let waiting = false;
    const runtime = new SupervisedPrivacyRuntime(
      (onUnavailable) => {
        const child = new FakeRuntime(onUnavailable);
        children.push(child);
        return child;
      },
      {
        wait: (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            waiting = true;
            signal.addEventListener(
              "abort",
              () => reject(new Error("stopped")),
              { once: true }
            );
          })
      }
    );
    await runtime.load();
    children[0]!.fail();
    await vi.waitFor(() => expect(waiting).toBe(true));
    await runtime.dispose();
    expect(children).toHaveLength(1);
    expect(children[0]!.disposed).toBe(true);
    expect(runtime.isReady()).toBe(false);
  });
});
