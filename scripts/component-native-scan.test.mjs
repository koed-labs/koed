import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { scanNativeAddons } from "./component-native-scan.mjs";

test("scans every staged addon and accepts modern and legacy N-API registration", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-scan-"));
  try {
    mkdirSync(resolve(root, "nested"));
    writeFileSync(resolve(root, "modern.node"), "fixture");
    writeFileSync(resolve(root, "nested/legacy.node"), "fixture");
    const results = scanNativeAddons(root, "macos", (_command, args) => ({
      status: (assert.deepEqual(args.slice(0, -1), ["-g"]), 0),
      stdout: args.at(-1).endsWith("modern.node")
        ? "0000000000001234 T _napi_register_module_v1\n"
        : "                 U _napi_module_register\n"
    }));
    assert.deepEqual(results, {
      addons: ["modern.node", "nested/legacy.node"],
      libraries: []
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans shared libraries for ABI imports without rejecting unrelated defined namespaces", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-scan-"));
  try {
    writeFileSync(resolve(root, "addon.node"), "fixture");
    writeFileSync(resolve(root, "libordinary.so.1"), "fixture");
    writeFileSync(resolve(root, "libother.dylib"), "fixture");
    const run = (_command, args) => {
      assert.deepEqual(args.slice(0, -1), ["-D", "-g"]);
      return {
        status: 0,
        stdout: args.at(-1).endsWith(".node")
          ? "00000000 T napi_register_module_v1\n"
          : "00000000 T _ZN4node4testEv\n"
      };
    };
    assert.deepEqual(scanNativeAddons(root, "linux", run), {
      addons: ["addon.node"],
      libraries: ["libordinary.so.1", "libother.dylib"]
    });
    for (const type of ["U", "w"]) {
      assert.throws(
        () =>
          scanNativeAddons(root, "linux", (_cmd, args) => ({
            status: 0,
            stdout: args.at(-1).endsWith(".so.1")
              ? `                 ${type} _ZN2v86Object3NewEv@VERSION\n`
              : "00000000 T napi_register_module_v1\n"
          })),
        /Node\/V8 ABI/
      );
    }
    assert.throws(
      () =>
        scanNativeAddons(root, "macos", (_cmd, args) => ({
          status: 0,
          stdout: args.at(-1).endsWith(".dylib")
            ? "                 U __ZN4node3FooEv\n"
            : "00000000 T _napi_register_module_v1\n"
        })),
      /Node\/V8 ABI/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const elfFixtureSkipReason = (platform, required, run = spawnSync) => {
  if (platform !== "linux") return "Linux ELF fixture requires Linux";
  const missing = ["cc", "strip"].filter((tool) => {
    const result = run(tool, ["--version"], { stdio: "ignore" });
    if (result.error?.code === "ENOENT") return true;
    if (result.error || result.status !== 0)
      throw new Error(
        `Cannot run ${tool}: ${result.error?.message ?? `exit ${result.status}`}`
      );
    return false;
  });
  if (!missing.length) return false;
  const reason = `ELF fixture tools not found: ${missing.join(", ")}`;
  if (required) throw new Error(reason);
  return reason;
};

test("ELF fixture skips missing tools locally but fails when CI requires them", () => {
  const missing = (tool) =>
    tool === "cc"
      ? { error: Object.assign(new Error("missing"), { code: "ENOENT" }) }
      : { status: 0 };
  assert.match(
    elfFixtureSkipReason("linux", false, missing),
    /tools not found: cc/
  );
  assert.throws(
    () => elfFixtureSkipReason("linux", true, missing),
    /tools not found: cc/
  );
  assert.equal(
    elfFixtureSkipReason("linux", true, () => ({ status: 0 })),
    false
  );
  assert.match(elfFixtureSkipReason("darwin", true, missing), /Linux/);
});

test("inspects actual stripped Linux ELF dynamic symbols", (context) => {
  const skipReason = elfFixtureSkipReason(
    process.platform,
    Boolean(process.env.CI) || process.env.KOED_REQUIRE_ELF_FIXTURE === "1"
  );
  if (skipReason) return context.skip(skipReason);
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-elf-"));
  try {
    const source = resolve(root, "addon.c");
    writeFileSync(source, "void napi_register_module_v1(void) {}\n");
    execFileSync("cc", [
      "-shared",
      "-fPIC",
      source,
      "-o",
      resolve(root, "addon.node")
    ]);
    execFileSync("strip", ["--strip-unneeded", resolve(root, "addon.node")]);
    assert.deepEqual(scanNativeAddons(root, "linux"), {
      addons: ["addon.node"],
      libraries: []
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ABI-bound, missing or malformed registration and scanner failure", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-native-scan-"));
  try {
    writeFileSync(resolve(root, "addon.node"), "fixture");
    for (const stdout of [
      "00000000 T napi_register_module_v1\n                 U node_module_register\n",
      "00000000 T napi_register_module_v1\n00000000 T node_register_module_v137\n",
      "00000000 T napi_register_module_v1\n                 U _ZN2v86Object3NewEPNS_7IsolateE\n",
      "                 U napi_register_module_v1\n",
      "00000000 T napi_module_register\n",
      "00000000 T unrelated\n",
      "garbled output"
    ]) {
      assert.throws(
        () => scanNativeAddons(root, "linux", () => ({ status: 0, stdout })),
        /native addon/i
      );
    }
    assert.throws(
      () =>
        scanNativeAddons(root, "linux", () => ({
          status: 1,
          stderr: "bad binary"
        })),
      /bad binary/
    );
    assert.throws(
      () =>
        scanNativeAddons(root, "linux", () => ({
          error: new Error("scanner missing")
        })),
      /scanner missing/
    );
    assert.throws(() => scanNativeAddons(root, "windows"), /unsupported/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
