import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ directorySync: 0, failAt: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync(fd: number) {
      if (
        actual.fstatSync(fd).isDirectory() &&
        ++fault.directorySync === fault.failAt
      )
        throw new Error("injected directory fsync failure");
      return actual.fsyncSync(fd);
    }
  };
});
import { resolveKoedServerPaths } from "../paths.js";
import {
  acquireControlPlaneAdmission,
  releaseControlPlaneAdmission,
  type ControlPlaneAdmission
} from "./admission.js";
import {
  applyControlIntent,
  createControlStateStore,
  type ControlIntent
} from "./state.js";

const stopped: ControlIntent = {
  schemaVersion: 1,
  revision: 4,
  stopIntent: true,
  backgroundEnabled: false,
  persistentCli: false,
  runtimeClean: true,
  protectedGenerationId: null
};

const roots: string[] = [];
const admissions: ControlPlaneAdmission[] = [];
afterEach(() => {
  for (const admission of admissions.splice(0))
    releaseControlPlaneAdmission(admission);
  fault.directorySync = 0;
  fault.failAt = 0;
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "control-state-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  mkdirSync(paths.configDir, { mode: 0o700 });
  const admission = acquireControlPlaneAdmission(paths)!;
  admissions.push(admission);
  return {
    admission,
    store: createControlStateStore(paths, admission),
    file: resolve(paths.configDir, "control-plane-state.json"),
    root
  };
}

describe("durable control state", () => {
  it("requires a live, unforgeable admission for all state access", () => {
    const { root, admission, store } = fixture();
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    expect(() =>
      createControlStateStore(paths, { ...admission }).initialize({
        kind: "absent"
      })
    ).toThrow();
    store.initialize({ kind: "absent" });
    releaseControlPlaneAdmission(admission);
    admissions.splice(admissions.indexOf(admission), 1);
    expect(() => store.read()).toThrow();
    expect(() => store.write(stopped, 0)).toThrow();
  });
  it("persists a transition and rejects a stale write without altering bytes", () => {
    const { store, file } = fixture();
    store.initialize({ kind: "absent" });
    const initialized = store.read();
    const explicitlyStopped = applyControlIntent(initialized, {
      action: "stop",
      explicit: true
    });
    store.write(explicitlyStopped, initialized.revision);
    const restored = store.read();
    expect(restored.stopIntent).toBe(true);
    const next = applyControlIntent(restored, {
      action: "start",
      explicit: true
    });
    store.write(next, restored.revision);
    expect(store.read()).toEqual(next);
    const bytes = readFileSync(file, "utf8");
    expect(() => store.write(explicitlyStopped, restored.revision)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("initializes unclean until independently verified prior-runtime evidence is available", () => {
    const { store } = fixture();
    store.initialize({ kind: "absent" });
    expect(store.read().runtimeClean).toBe(false);
  });

  it("imports legacy explicit Stop before automatic startup is considered", () => {
    const { store } = fixture();
    store.initialize({ kind: "valid", stopIntent: true });
    const migrated = store.read();
    expect(migrated.stopIntent).toBe(true);
    expect(
      applyControlIntent(migrated, { action: "start", explicit: false })
    ).toEqual(migrated);
  });

  it("does not poison a valid state on duplicate initialization or invalid write", () => {
    const { store } = fixture();
    store.initialize({ kind: "absent" });
    const current = store.read();
    expect(() => store.initialize({ kind: "absent" })).toThrow();
    expect(store.read()).toEqual(current);
    expect(() =>
      store.write(
        {
          ...current,
          revision: 1,
          stopIntent: "no"
        } as unknown as ControlIntent,
        0
      )
    ).toThrow();
    expect(store.read()).toEqual(current);
  });

  it("rejects unknown legacy state instead of initializing", () => {
    const { store } = fixture();
    expect(() => store.initialize({ kind: "invalid" })).toThrow();
    expect(() => store.read()).toThrow();
  });

  it("accepts a symlinked home ancestor while still rejecting a symlinked config directory", () => {
    const { root, admission } = fixture();
    const alias = resolve(root, "alias");
    symlinkSync(root, alias);
    const aliased = createControlStateStore(
      resolveKoedServerPaths({ KOED_HOME: alias }),
      admission
    );
    aliased.initialize({ kind: "absent" });
    expect(aliased.read().stopIntent).toBe(false);
    rmSync(resolve(root, "config"), { recursive: true });
    const other = resolve(root, "other-config");
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(other, resolve(root, "config"));
    expect(() => aliased.read()).toThrow();
  });

  it("poisons the process when the marker directory fsync fails even if the marker disappears", () => {
    const { store, file } = fixture();
    store.initialize({ kind: "absent" });
    const current = store.read();
    fault.directorySync = 0;
    fault.failAt = 1;
    expect(() =>
      store.write(
        applyControlIntent(current, { action: "stop", explicit: true }),
        current.revision
      )
    ).toThrow("injected directory fsync failure");
    fault.failAt = 0;
    rmSync(`${file}.pending`);
    expect(() => store.read()).toThrow("uncertain");
  });

  it("blocks future reads after directory fsync fails following state publication", () => {
    const { store } = fixture();
    store.initialize({ kind: "absent" });
    const current = store.read();
    fault.directorySync = 0;
    fault.failAt = 2;
    expect(() =>
      store.write(
        applyControlIntent(current, { action: "stop", explicit: true }),
        current.revision
      )
    ).toThrow("injected directory fsync failure");
    fault.failAt = 0;
    expect(() => store.read()).toThrow("uncertain");
  });

  it("poisons all store instances after final directory fsync fails", () => {
    const { store, root, admission } = fixture();
    store.initialize({ kind: "absent" });
    const current = store.read();
    fault.directorySync = 0;
    fault.failAt = 3;
    expect(() =>
      store.write(
        applyControlIntent(current, { action: "stop", explicit: true }),
        current.revision
      )
    ).toThrow("injected directory fsync failure");
    fault.failAt = 0;
    expect(() => store.read()).toThrow("uncertain");
    const another = createControlStateStore(
      resolveKoedServerPaths({ KOED_HOME: root }),
      admission
    );
    expect(() => another.read()).toThrow("uncertain");
  });

  it("blocks state access when a previous write was interrupted after publication", () => {
    const { store, file } = fixture();
    store.initialize({ kind: "absent" });
    writeFileSync(`${file}.pending`, "", { mode: 0o600 });
    expect(() => store.read()).toThrow();
    expect(() => store.write({ ...stopped, revision: 5 }, 4)).toThrow();
  });

  it("rejects missing, malformed, and symlinked state", () => {
    const { store, file, root } = fixture();
    expect(() => store.read()).toThrow();
    writeFileSync(file, "not json", { mode: 0o600 });
    expect(() => store.read()).toThrow();
    rmSync(file);
    const target = resolve(root, "other");
    writeFileSync(target, JSON.stringify(stopped));
    symlinkSync(target, file);
    expect(() => store.read()).toThrow();
    expect(() => store.initialize({ kind: "absent" })).toThrow();
  });
});

describe("control intent transitions", () => {
  it("does not let an automatic start clear an explicit stop", () => {
    expect(
      applyControlIntent(stopped, { action: "start", explicit: false })
    ).toEqual(stopped);
  });

  it("allows an explicit start to clear stop intent", () => {
    expect(
      applyControlIntent(stopped, { action: "start", explicit: true })
    ).toEqual({
      ...stopped,
      revision: 5,
      stopIntent: false
    });
  });

  it("fences stale starts even when Stop was already set", () => {
    expect(
      applyControlIntent(stopped, { action: "stop", explicit: true })
    ).toEqual({
      ...stopped,
      revision: 5
    });
  });

  it("does not turn session-end stop into a durable explicit stop", () => {
    const running = { ...stopped, stopIntent: false };
    expect(
      applyControlIntent(running, { action: "stop", explicit: false })
    ).toEqual(running);
    expect(
      applyControlIntent(running, { action: "stop", explicit: true })
    ).toEqual({
      ...running,
      revision: 5,
      stopIntent: true
    });
  });
});
