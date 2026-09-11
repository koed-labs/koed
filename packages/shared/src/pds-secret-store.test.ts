import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPdsApplicationSecretStore,
  pdsApplicationSecretStorePaths
} from "./pds-secret-store.js";

const roots: string[] = [];

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "koed-pds-store-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("application-managed PDS secret store", () => {
  it("persists encrypted values across store instances", () => {
    const root = createRoot();
    const store = createPdsApplicationSecretStore({ rootPath: root });
    store.put("pds-runtime", "runtime-secret");

    const paths = pdsApplicationSecretStorePaths({ rootPath: root });
    expect(readFileSync(paths.storePath, "utf8")).not.toContain(
      "runtime-secret"
    );
    expect(lstatSync(paths.storePath).mode & 0o077).toBe(0);
    expect(lstatSync(paths.keyPath).mode & 0o077).toBe(0);
    expect(
      createPdsApplicationSecretStore({ rootPath: root }).get("pds-runtime")
    ).toBe("runtime-secret");

    store.delete("pds-runtime");
    expect(store.get("pds-runtime")).toBeNull();
  });

  it("enforces reference and value bounds", () => {
    const store = createPdsApplicationSecretStore({ rootPath: createRoot() });
    expect(() => store.get("not a reference")).toThrow("reference is invalid");
    expect(() => store.put("pds-runtime", "x".repeat(2_000_001))).toThrow(
      "value is too large"
    );
  });

  it("rejects unsafe store directories", () => {
    const root = createRoot();
    const secrets = join(root, "secrets");
    writeFileSync(join(root, "marker"), "outside");
    symlinkSync(join(root, "marker"), secrets);
    expect(() =>
      createPdsApplicationSecretStore({ rootPath: root }).put(
        "pds-runtime",
        "secret"
      )
    ).toThrow("directory is unsafe");
  });

  it("rejects a symbolic-link KOED_HOME", () => {
    const root = createRoot();
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias);
    expect(() =>
      createPdsApplicationSecretStore({ rootPath: alias }).put(
        "pds-runtime",
        "secret"
      )
    ).toThrow("path is unsafe");
  });

  it("rejects unsafe existing store files", () => {
    const root = createRoot();
    const paths = pdsApplicationSecretStorePaths({ rootPath: root });
    const storeDirectory = join(root, "secrets");
    writeFileSync(join(root, "marker"), "outside");
    // Establish directory before replacing the expected store path with a symlink.
    chmodSync(root, 0o700);
    mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(join(root, "marker"), paths.storePath);
    expect(() =>
      createPdsApplicationSecretStore({ rootPath: root }).get("pds-runtime")
    ).toThrow("file is unsafe");
  });

  it("rejects adding an entry beyond the bounded entry count", () => {
    const root = createRoot();
    const store = createPdsApplicationSecretStore({ rootPath: root });
    store.put("seed", "value");
    const paths = pdsApplicationSecretStorePaths({ rootPath: root });
    const state = JSON.parse(readFileSync(paths.storePath, "utf8")) as {
      updatedAt: string;
      secrets: Record<string, unknown>;
    };
    const envelope = state.secrets.seed;
    state.secrets = Object.fromEntries(
      Array.from({ length: 1_024 }, (_, index) => [`entry-${index}`, envelope])
    );
    writeFileSync(paths.storePath, `${JSON.stringify(state)}\n`, {
      mode: 0o600
    });
    expect(() => store.put("entry-over-limit", "value")).toThrow(
      "too many entries"
    );
    expect(
      Object.keys(
        (
          JSON.parse(readFileSync(paths.storePath, "utf8")) as {
            secrets: object;
          }
        ).secrets
      )
    ).toHaveLength(1_024);
  });

  it("binds encrypted values to their references", () => {
    const root = createRoot();
    const store = createPdsApplicationSecretStore({ rootPath: root });
    store.put("first", "first-value");
    store.put("second", "second-value");
    const paths = pdsApplicationSecretStorePaths({ rootPath: root });
    const state = JSON.parse(readFileSync(paths.storePath, "utf8")) as {
      secrets: Record<string, unknown>;
    };
    [state.secrets.first, state.secrets.second] = [
      state.secrets.second,
      state.secrets.first
    ];
    writeFileSync(paths.storePath, `${JSON.stringify(state)}\n`, {
      mode: 0o600
    });
    expect(() => store.get("first")).toThrow("value is invalid");
  });

  it("supports prototype-looking references without inherited-property confusion", () => {
    const store = createPdsApplicationSecretStore({ rootPath: createRoot() });
    store.put("__proto__", "prototype-value");
    expect(store.get("__proto__")).toBe("prototype-value");
    store.delete("__proto__");
    expect(store.get("__proto__")).toBeNull();
  });
});
