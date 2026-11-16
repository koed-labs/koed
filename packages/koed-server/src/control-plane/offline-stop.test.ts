import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveKoedServerPaths } from "../paths.js";
import { withLifecycleLock } from "../generation-lifecycle.js";
import { recordOfflineStop } from "./offline-stop.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(clean: boolean) {
  const scratch = resolve(import.meta.dirname, "../../../../scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(resolve(scratch, "offline-stop-"));
  roots.push(root);
  const paths = resolveKoedServerPaths({ KOED_HOME: root });
  mkdirSync(paths.configDir, { mode: 0o700 });
  mkdirSync(paths.runDir, { mode: 0o700 });
  const file = resolve(paths.configDir, "control-plane-state.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      stopIntent: false,
      backgroundEnabled: true,
      persistentCli: true,
      runtimeClean: clean,
      protectedGenerationId: clean ? null : "generation"
    }),
    { mode: 0o600 }
  );
  return { paths, file };
}
it("records a durable explicit Stop without starting a host", () => {
  const { paths, file } = fixture(true);
  expect(recordOfflineStop(paths)).toEqual({ clean: true });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    revision: 5,
    stopIntent: true,
    backgroundEnabled: true,
    persistentCli: false,
    runtimeClean: true
  });
});
it("does not claim cleanup when a clean record has prior runtime evidence", () => {
  const { paths, file } = fixture(true);
  writeFileSync(paths.runtimeStatePath, "{}", { mode: 0o600 });
  expect(recordOfflineStop(paths)).toEqual({ clean: false });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    stopIntent: true,
    runtimeClean: false
  });
});
it("records intent but preserves unclean runtime evidence", () => {
  const { paths, file } = fixture(false);
  expect(recordOfflineStop(paths)).toEqual({ clean: false });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    stopIntent: true,
    runtimeClean: false,
    protectedGenerationId: "generation"
  });
});
it("does not overwrite a malformed or stale discovery record", () => {
  const { paths, file } = fixture(true);
  writeFileSync(resolve(paths.runDir, "control-plane.json"), "not-json", {
    mode: 0o600
  });
  expect(() => recordOfflineStop(paths)).toThrow();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    revision: 4,
    stopIntent: false
  });
});
it("records Stop with the practical fresh-home baseline", () => {
  const { paths, file } = fixture(true);
  rmSync(file);
  expect(recordOfflineStop(paths)).toEqual({ clean: true });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    stopIntent: true,
    runtimeClean: true
  });
});
it("records Stop after a dead supervisor with reclaim exclusion", () => {
  const { paths, file } = fixture(true);
  const discovery = resolve(paths.runDir, "control-plane.json");
  writeFileSync(
    discovery,
    JSON.stringify({
      schemaVersion: 1,
      home: paths.koedHome,
      instanceId: "old",
      installationId: "install",
      productVersion: "1",
      socketPath: resolve(paths.koedHome, "s"),
      pid: 99999999,
      processIdentity: "dead"
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    resolve(paths.runDir, "koed-server.lock"),
    JSON.stringify({
      pid: 99999999,
      acquiredAt: "2025-01-01T00:00:00.000Z",
      processIdentity: "dead"
    }),
    { mode: 0o600 }
  );
  expect(recordOfflineStop(paths, { tryReclaimLock: () => true })).toEqual({
    clean: true
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    stopIntent: true
  });
  expect(JSON.parse(readFileSync(discovery, "utf8"))).toMatchObject({
    pid: 99999999
  });
});
it("leaves a busy lifecycle operation for the online control path", () => {
  const { paths } = fixture(true);
  withLifecycleLock(paths, () =>
    expect(recordOfflineStop(paths)).toBeUndefined()
  );
});
it("does not take over an existing lock", () => {
  const { paths, file } = fixture(true);
  writeFileSync(
    resolve(paths.runDir, "koed-server.lock"),
    JSON.stringify({
      pid: 99999999,
      acquiredAt: "2025-01-01T00:00:00.000Z",
      processIdentity: "dead"
    })
  );
  expect(recordOfflineStop(paths)).toBeUndefined();
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
    revision: 4,
    stopIntent: false
  });
});
