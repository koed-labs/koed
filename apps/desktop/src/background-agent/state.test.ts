import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundAgentStateStore } from "./state.js";

const temporaryRoots: string[] = [];
const installation = (root: string) => ({
  installationId: randomUUID(),
  bundlePath: join(root, "Koed.app"),
  koedHome: join(root, "koed-home")
});

const createStore = () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "koed-agent-state-"));
  temporaryRoots.push(root);
  const identity = installation(root);
  mkdirSync(identity.koedHome, { mode: 0o700 });
  return {
    root,
    identity,
    store: createBackgroundAgentStateStore({ installation: identity })
  };
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("background-agent durable state", () => {
  it("initializes private state and advances generation on explicit start and stop", () => {
    const { store } = createStore();
    const initial = store.initialize();
    expect(initial).toMatchObject({
      generation: 0,
      state: "stopped",
      stopIntent: false
    });

    const starting = store.start({ expectedGeneration: 0, explicit: true });
    expect(starting).toMatchObject({
      generation: 1,
      state: "starting",
      stopIntent: false
    });
    expect(store.markReady(1)).toMatchObject({ generation: 1, state: "ready" });

    const stopped = store.stop(1);
    expect(stopped).toMatchObject({
      generation: 2,
      state: "stopped",
      stopIntent: true
    });
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
  });

  it("reuses a persisted installation UUID when later processes reopen state", () => {
    const { identity } = createStore();
    const installation = {
      bundlePath: identity.bundlePath,
      koedHome: identity.koedHome
    };
    const firstStore = createBackgroundAgentStateStore({ installation });
    const created = firstStore.initialize();
    const nextStore = createBackgroundAgentStateStore({ installation });

    expect(created.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(nextStore.read()).toMatchObject({
      kind: "valid",
      state: { installationId: created.installationId }
    });
  });

  it("records failed durable Stop as attention without clearing stop intent", () => {
    const { store } = createStore();
    const initial = store.initialize();
    const starting = store.start({
      expectedGeneration: initial.generation,
      explicit: true
    });
    const stopped = store.stop(starting.generation, true);

    expect(store.markStopNeedsAttention(stopped.generation)).toMatchObject({
      state: "needs_attention",
      stopIntent: true
    });
    expect(() =>
      store.start({ expectedGeneration: stopped.generation, explicit: false })
    ).toThrow(
      "Explicit Start is required to clear the Background Agent stop intent."
    );
  });

  it("fences crash recovery generations and does not retry attention states", () => {
    const { store } = createStore();
    store.initialize();
    const first = store.recover();
    store.markReady(first.generation);
    const recovered = store.recover();
    expect(recovered).toMatchObject({
      generation: first.generation + 1,
      state: "starting"
    });
    expect(() => store.markReady(first.generation)).toThrow(
      "Background Agent generation is stale."
    );
    store.markNeedsAttention(recovered.generation);
    expect(() => store.recover()).toThrow(
      "Explicit Start is required to retry a Background Agent needing attention."
    );
  });

  it("keeps maintenance stops distinct from durable user Stop", () => {
    const { store } = createStore();
    store.initialize();
    const starting = store.start({ expectedGeneration: 0, explicit: true });
    store.markReady(starting.generation);

    const stopped = store.stop(starting.generation, false);
    expect(stopped).toMatchObject({
      generation: starting.generation + 1,
      state: "stopped",
      stopIntent: false
    });
    expect(
      store.start({ expectedGeneration: stopped.generation, explicit: false })
    ).toMatchObject({
      generation: stopped.generation + 1,
      state: "starting",
      stopIntent: false
    });
  });

  it("does not clear durable Stop without an explicit current-generation Start", () => {
    const { store } = createStore();
    store.initialize();
    store.start({ expectedGeneration: 0, explicit: true });
    store.stop(1);

    expect(() =>
      store.start({ expectedGeneration: 2, explicit: false })
    ).toThrow(
      "Explicit Start is required to clear the Background Agent stop intent."
    );
    expect(() =>
      store.start({ expectedGeneration: 1, explicit: true })
    ).toThrow("Background Agent generation is stale.");
    expect(
      store.start({ expectedGeneration: 2, explicit: true })
    ).toMatchObject({ generation: 3, state: "starting", stopIntent: false });
  });

  it("fails closed for corrupt, symlinked, or installation-mismatched state", () => {
    const { root, identity, store } = createStore();
    store.initialize();
    writeFileSync(store.statePath, "{bad json", { mode: 0o600 });
    expect(store.read()).toMatchObject({ kind: "invalid" });
    expect(() =>
      store.start({ expectedGeneration: 0, explicit: true })
    ).toThrow("Background Agent state is invalid.");

    rmSync(store.statePath);
    const target = join(identity.koedHome, "target.json");
    writeFileSync(target, JSON.stringify({}), { mode: 0o600 });
    symlinkSync(target, store.statePath);
    expect(store.read()).toMatchObject({ kind: "invalid" });

    rmSync(store.statePath);
    rmSync(target);
    const runDirectory = join(identity.koedHome, "run");
    rmSync(runDirectory, { recursive: true, force: true });
    const externalRunDirectory = join(root, "external-run");
    mkdirSync(externalRunDirectory, { mode: 0o700 });
    symlinkSync(externalRunDirectory, runDirectory);
    expect(store.read()).toMatchObject({ kind: "invalid" });
    rmSync(runDirectory);

    const replacement = createBackgroundAgentStateStore({
      installation: {
        ...identity,
        bundlePath: join(root, "Other.app")
      }
    });
    store.initialize();
    expect(replacement.read()).toMatchObject({ kind: "invalid" });

    const validState = store.read();
    if (validState.kind !== "valid") throw new Error("Test state is missing.");
    const invalidInvariant = { ...validState.state };
    invalidInvariant.state = "ready";
    invalidInvariant.stopIntent = true;
    writeFileSync(store.statePath, JSON.stringify(invalidInvariant), {
      mode: 0o600
    });
    expect(store.read()).toMatchObject({ kind: "invalid" });
  });

  it("does not overwrite an existing initialization or accept unsafe state files", () => {
    const { store } = createStore();
    store.initialize();
    expect(() => store.initialize()).toThrow(
      "Background Agent state is already initialized."
    );
    chmodSync(store.statePath, 0o644);
    expect(store.read()).toMatchObject({ kind: "invalid" });
  });
});
