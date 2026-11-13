import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundAgentStateStore } from "./state.js";
import {
  BACKGROUND_AGENT_PROTOCOL_VERSION,
  parseBackgroundAgentRequest
} from "./protocol.js";
import { createBackgroundAgentController } from "./agent-controller.js";

const temporaryRoots: string[] = [];
const createFixture = () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "koed-agent-controller-")
  );
  temporaryRoots.push(root);
  const koedHome = join(root, "koed-home");
  mkdirSync(koedHome, { mode: 0o700 });
  const store = createBackgroundAgentStateStore({
    installation: { bundlePath: join(root, "Koed.app"), koedHome }
  });
  store.initialize();
  const manager = {
    resume: vi.fn(async () => ({ ok: true, state: "healthy" })),
    stopRuntime: vi.fn(async (_explicit: boolean) => ({
      ok: true,
      state: "stopped"
    })),
    handlers: {
      start_daemon: vi.fn(async () => ({ ok: true, state: "starting" })),
      status: vi.fn(async () => ({ ok: true, state: "healthy" }))
    }
  };
  const controller = createBackgroundAgentController({ store, manager });
  return { controller, manager, store };
};

const makeReadRequest = (kind: "hello" | "status", installationId: string) =>
  parseBackgroundAgentRequest(
    JSON.stringify({
      protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
      requestId: randomUUID(),
      installationId,
      homeIdentity: "a".repeat(64),
      kind
    })
  );

const makeRequest = (
  kind: "start" | "stop",
  installationId: string,
  expectedGeneration: number,
  explicit: boolean
) =>
  parseBackgroundAgentRequest(
    JSON.stringify({
      protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
      requestId: randomUUID(),
      installationId,
      homeIdentity: "a".repeat(64),
      kind,
      expectedGeneration,
      explicit
    })
  );

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("background-agent controller", () => {
  it("answers Hello while startup readiness is still pending", async () => {
    const { controller, manager, store } = createFixture();
    let resolveResume!: (value: { ok: boolean; state: string }) => void;
    manager.resume.mockImplementation(
      () =>
        new Promise<{ ok: boolean; state: string }>((resolve) => {
          resolveResume = resolve;
        })
    );
    const starting = controller.startup();
    const state = store.read();
    if (state.kind !== "valid") throw new Error("State is missing.");

    const hello = await Promise.race([
      controller.handle(makeReadRequest("hello", state.state.installationId)),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 20)
      )
    ]);
    resolveResume?.({ ok: true, state: "healthy" });
    await starting;

    expect(hello).not.toBe("pending");
    expect(hello).toMatchObject({ state: "starting", generation: 1 });
  });

  it("starts only after verification resume and persists ready state", async () => {
    const { controller, manager, store } = createFixture();

    await expect(controller.startup()).resolves.toMatchObject({
      state: "ready",
      stopIntent: false,
      generation: 1
    });
    expect(manager.resume).toHaveBeenCalledOnce();
    expect(store.read()).toMatchObject({
      kind: "valid",
      state: { state: "ready", generation: 1 }
    });
  });

  it("persists Stop before shutting down and requires explicit Start to resume", async () => {
    const { controller, manager, store } = createFixture();
    await controller.startup();
    const readyState = store.read();
    if (readyState.kind !== "valid") throw new Error("State is missing.");
    manager.stopRuntime.mockImplementation(async (explicit) => {
      expect(store.read()).toMatchObject({
        kind: "valid",
        state: { stopIntent: true, state: "stopped" }
      });
      return { ok: true, state: "stopped", explicit };
    });

    const stopped = await controller.handle(
      makeRequest("stop", readyState.state.installationId, 1, true)
    );
    expect(stopped).toMatchObject({
      ok: true,
      state: "stopped",
      generation: 2
    });
    await expect(
      controller.handle(
        makeRequest("start", readyState.state.installationId, 2, false)
      )
    ).resolves.toMatchObject({
      ok: false,
      state: "stopped",
      errorCode: "not_authorized"
    });
    expect(manager.handlers.start_daemon).not.toHaveBeenCalled();

    await expect(
      controller.handle(
        makeRequest("start", readyState.state.installationId, 2, true)
      )
    ).resolves.toMatchObject({ ok: true, state: "starting", generation: 3 });
    await vi.waitFor(() =>
      expect(store.read()).toMatchObject({
        kind: "valid",
        state: { state: "ready", generation: 3 }
      })
    );
    expect(manager.handlers.start_daemon).toHaveBeenCalledOnce();
  });

  it("keeps durable Stop intent but reports attention when shutdown fails", async () => {
    const { controller, manager, store } = createFixture();
    await controller.startup();
    const readyState = store.read();
    if (readyState.kind !== "valid") throw new Error("State is missing.");
    manager.stopRuntime.mockResolvedValue({
      ok: false,
      state: "needs_attention"
    });

    await expect(
      controller.handle(
        makeRequest("stop", readyState.state.installationId, 1, true)
      )
    ).resolves.toMatchObject({
      ok: false,
      state: "needs_attention",
      errorCode: "stop_failed"
    });
    expect(store.read()).toMatchObject({
      kind: "valid",
      state: { state: "needs_attention", stopIntent: true }
    });
  });

  it("keeps maintenance stop non-durable and permits a non-explicit restart", async () => {
    const { controller, manager, store } = createFixture();
    await controller.startup();
    const readyState = store.read();
    if (readyState.kind !== "valid") throw new Error("State is missing.");

    await expect(
      controller.handle(
        makeRequest("stop", readyState.state.installationId, 1, false)
      )
    ).resolves.toMatchObject({ ok: true, state: "stopped", generation: 2 });
    expect(store.read()).toMatchObject({
      kind: "valid",
      state: { state: "stopped", stopIntent: false }
    });
    await expect(
      controller.handle(
        makeRequest("start", readyState.state.installationId, 2, false)
      )
    ).resolves.toMatchObject({ ok: true, state: "starting", generation: 3 });
    expect(manager.stopRuntime).toHaveBeenCalledWith(false);
    expect(manager.handlers.start_daemon).toHaveBeenCalledOnce();
    expect(manager.resume).toHaveBeenCalledOnce();
    expect(manager.handlers.status).toHaveBeenCalled();
  });

  it("does not resume an explicitly stopped agent after process restart", async () => {
    const { controller, manager, store } = createFixture();
    store.stop(0, true);

    await expect(controller.startup()).resolves.toMatchObject({
      state: "stopped",
      stopIntent: true,
      generation: 1
    });
    expect(manager.resume).not.toHaveBeenCalled();
  });
});
