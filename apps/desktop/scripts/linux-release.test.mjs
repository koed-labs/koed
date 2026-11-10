import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  freezeCore,
  verifyFrozenCore
} from "../../../scripts/native-runtime/core-artifact.mjs";
import { writeRuntimeAssetManifest } from "../../../scripts/native-runtime/manifest-lib.mjs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const desktop = resolve(import.meta.dirname, "..");
const guard = resolve(desktop, "scripts/validate-linux-release.mjs");

test("Linux release host guard accepts only Linux x64 before packaging", async () => {
  const { validateLinuxReleaseHost } =
    await import("./validate-linux-release-host.mjs");
  assert.doesNotThrow(() => validateLinuxReleaseHost("linux", "x64"));
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "arm64"]
  ]) {
    assert.throws(
      () => validateLinuxReleaseHost(platform, arch),
      /Linux x64 Node.js execution environment/
    );
  }
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  assert.match(
    pkg.scripts["package:linux:release"],
    /^node scripts\/validate-linux-release-host\.mjs && pnpm package:workspace:build && pnpm package:runtime &&/
  );
});

test("Linux release host CLI accepts Linux x64 and rejects unsupported Node environments", () => {
  for (const [platform, arch, expectedStatus] of [
    ["linux", "x64", 0],
    ["darwin", "x64", 1],
    ["darwin", "arm64", 1],
    ["linux", "arm64", 1]
  ]) {
    const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, 'platform', { value: '${platform}' }); Object.defineProperty(process, 'arch', { value: '${arch}' });`)}`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        resolve(desktop, "scripts/validate-linux-release-host.mjs")
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, expectedStatus, result.stderr);
    if (expectedStatus) {
      assert.match(result.stderr, /Linux x64 Node\.js execution environment/);
      assert.match(result.stderr, new RegExp(`${platform} ${arch}`));
    } else {
      assert.equal(result.stderr, "");
    }
    assert.equal(result.stdout, "");
  }
});

test("Linux release config targets x64 AppImage with explicit artifact name", () => {
  const config = parse(
    readFileSync(join(desktop, "electron-builder.yml"), "utf8")
  );
  assert.ok(config.linux.target.includes("AppImage"));
  assert.equal(config.linux.artifactName, "Koed-${version}-${arch}.${ext}");
  assert.equal(config.linux.executableName, "koed");
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  assert.match(pkg.scripts["package:linux:release"], /--linux AppImage --x64/);
});

test("release guard rejects missing source and non-Linux x64 staging", (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = () =>
    spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: "" }
    });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "darwin", architecture: "arm64" } })
  );
  let result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux x64/);
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native|Linux x64/i);
});

test("release guard accepts validated staging and propagates validator failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  const module = await import("./validate-linux-release.mjs");
  const options = {
    runtimeRoot: root,
    platform: "linux",
    arch: "x64",
    nativeRuntimeSource: root,
    verifyCore: () => {}
  };
  const runValidator = (_command, args) => {
    assert.equal(args[1], "--runtime-root");
    assert.equal(
      readFileSync(join(args[2], "desktop-bundle-manifest.json"), "utf8"),
      readFileSync(join(root, "desktop-bundle-manifest.json"), "utf8")
    );
    return {
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        packagedProvider: { skipped: false, ok: true }
      }),
      stderr: ""
    };
  };
  assert.doesNotThrow(() =>
    module.validateLinuxRelease({ ...options, runValidator })
  );
  assert.throws(
    () =>
      module.validateLinuxRelease({
        ...options,
        runValidator: () => ({
          status: 1,
          stdout: JSON.stringify({ ok: false }),
          stderr: ""
        })
      }),
    /validation failed/i
  );
  assert.throws(
    () =>
      module.validateLinuxRelease({
        ...options,
        runValidator: () => ({
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            packagedProvider: { skipped: true }
          }),
          stderr: ""
        })
      }),
    /validation failed/i
  );
});

test(
  "Linux x64 release guard accepts a validated staged runtime",
  {
    skip:
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      !process.env.KOED_TEST_LINUX_RELEASE_RUNTIME
  },
  () => {
    const root = process.env.KOED_TEST_LINUX_RELEASE_RUNTIME;
    const result = spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: root },
      timeout: 300000
    });
    assert.equal(result.status, 0, result.stderr);
  }
);

test(
  "Linux x64 release guard runs native validator and rejects incomplete runtime",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
      join(root, "desktop-bundle-manifest.json"),
      JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
    );
    const result = spawnSync(process.execPath, [guard, root], {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: root }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /native.runtime.validation/i);
    assert.match(result.stderr, /validation failed/i);
  }
);

test("release guard validates native source and rejects a differing staged copy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const staged = join(root, "staged");
  for (const dir of [source, staged]) {
    mkdirSync(join(dir, "postgres/bin"), { recursive: true });
    writeFileSync(join(dir, "postgres/bin/postgres"), "native", {
      mode: 0o755
    });
    symlinkSync("bin/postgres", join(dir, "postgres/link"));
  }
  writeFileSync(
    join(staged, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  mkdirSync(join(staged, "node_modules/debug/src"), { recursive: true });
  const module = await import("./validate-linux-release.mjs");
  const validated = [];
  const options = {
    runtimeRoot: staged,
    platform: "linux",
    arch: "x64",
    nativeRuntimeSource: source,
    verifyCore: () => {},
    runValidator: (_command, args) => {
      validated.push(realpathSync(args[2]));
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          packagedProvider: { skipped: false, ok: true }
        }),
        stderr: ""
      };
    }
  };
  assert.doesNotThrow(() => module.validateLinuxRelease(options));
  assert.deepEqual(validated, [realpathSync(source)]);
  for (const [damage, pattern] of [
    [
      () => writeFileSync(join(staged, "postgres/bin/postgres"), "evil"),
      /file differs/
    ],
    [
      () => chmodSync(join(staged, "postgres/bin/postgres"), 0o644),
      /file differs/
    ],
    [() => rmSync(join(staged, "postgres/link")), /missing/],
    [
      () => {
        rmSync(join(staged, "postgres/link"));
        symlinkSync("../elsewhere", join(staged, "postgres/link"));
      },
      /symlink differs/
    ]
  ]) {
    rmSync(join(staged, "postgres"), { recursive: true, force: true });
    cpSync(join(source, "postgres"), join(staged, "postgres"), {
      recursive: true,
      verbatimSymlinks: true
    });
    damage();
    assert.throws(() => module.validateLinuxRelease(options), pattern);
  }
});

test("actual Linux staging preserves frozen manifest bytes and guard rejects tampering", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-staging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const path of [
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
    "postgres/bin/pg_dump",
    "postgres/bin/pg_restore",
    "postgres/lib/vector.so",
    "postgres/lib/pgcrypto.so",
    "llama.cpp/llama-server",
    "llama.cpp/cpu/llama-server"
  ]) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture ${path}\n`, {
      mode:
        path.includes("/bin/") || path.endsWith("llama-server") ? 0o755 : 0o644
    });
  }
  writeRuntimeAssetManifest({
    runtimeRoot: source,
    platform: "linux",
    architecture: "x64",
    versions: { postgres: "fixture-postgres", llamaCpp: "fixture-llama" }
  });
  const configuration = JSON.parse(
    readFileSync(
      new URL(
        "../../../scripts/native-runtime/core.linux-x64.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  const pinned = JSON.parse(
    readFileSync(
      new URL(
        "../../../scripts/native-runtime/sources.linux-x64.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  freezeCore({
    runtimeRoot: source,
    configuration,
    recipe: {
      schemaVersion: 1,
      kind: "core",
      configuration,
      sources: Object.fromEntries(
        ["postgres", "pgvector", "llamaCpp"].map((key) => [key, pinned[key]])
      ),
      toolchain: { cc: "fixture" },
      logic: { build: "a".repeat(64) },
      packaging: { epoch: 0 }
    }
  });
  verifyFrozenCore(source);
  const repo = join(root, "repo");
  const scripts = join(repo, "apps/desktop/scripts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  symlinkSync(
    resolve(desktop, "node_modules"),
    join(repo, "apps/desktop/node_modules")
  );
  symlinkSync(
    resolve(desktop, "../../node_modules"),
    join(repo, "node_modules")
  );
  symlinkSync(resolve(desktop, "../../packages"), join(repo, "packages"));
  symlinkSync(
    resolve(desktop, "../../scripts/native-runtime"),
    join(repo, "scripts/native-runtime")
  );
  symlinkSync(
    resolve(desktop, "../../scripts/native-runtime-copy.mjs"),
    join(repo, "scripts/native-runtime-copy.mjs")
  );
  for (const name of [
    "prepare-koed-runtime.mjs",
    "validate-linux-release.mjs",
    "finalize-runtime-manifests.mjs",
    "privacy-payload-inventory.mjs"
  ]) {
    cpSync(join(desktop, "scripts", name), join(scripts, name));
  }
  cpSync(
    join(desktop, "package.json"),
    join(repo, "apps/desktop/package.json")
  );
  const required = [
    "api/dist/index.js",
    "node_modules/@koed/db/dist/index.js",
    "node_modules/@koed/db/drizzle/meta/_journal.json",
    "worker/dist/index.js",
    "embedding-service/dist/index.js",
    "mcp-server/dist/cli.js",
    "mcp-server/dist/capture-hook.js",
    "mcp-server/dist/codex-memory-hook.js",
    "mcp-server/dist/prompts/codex-global-agent-guidance.md",
    "node_modules/@koed/mcp-server/dist/prompts/mcp-server-instructions.md",
    "node_modules/@koed/mcp-server/dist/prompts/codex-global-agent-guidance.md"
  ];
  const base = join(root, "base");
  for (const path of required) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), "fixture");
  }
  writeFileSync(
    join(repo, "scripts/component-assembly.mjs"),
    `export const stageRuntimeComponents = async () => ({ baseRoot: ${JSON.stringify(base)}, privacyOnlyPackages: [] });\n`
  );
  const preload = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'linux' }); Object.defineProperty(process, 'arch', { value: 'x64' });")}`;
  const result = spawnSync(
    process.execPath,
    ["--import", preload, join(scripts, "prepare-koed-runtime.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: source }
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const staged = join(repo, "apps/desktop/.koed-runtime");
  const manifest = "runtime-asset-manifest.json";
  const bytes = readFileSync(join(source, manifest));
  assert.deepEqual(readFileSync(join(staged, manifest)), bytes);
  const bundle = JSON.parse(
    readFileSync(join(staged, "desktop-bundle-manifest.json"), "utf8")
  );
  assert.equal(
    bundle.files.find((file) => file.path === manifest).sha256,
    createHash("sha256").update(bytes).digest("hex")
  );
  const { assertStagedNativeRuntimeMatches } =
    await import("./validate-linux-release.mjs");
  assert.doesNotThrow(() =>
    assertStagedNativeRuntimeMatches({ source, staged })
  );
  for (const path of [manifest, "postgres/bin/postgres"]) {
    const original = readFileSync(join(staged, path));
    writeFileSync(
      join(staged, path),
      Buffer.concat([original, Buffer.from("tamper")])
    );
    assert.throws(
      () => assertStagedNativeRuntimeMatches({ source, staged }),
      /file differs/
    );
    writeFileSync(join(staged, path), original);
  }
  const runStage = (input, arch = "x64") => {
    const override = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, 'platform', { value: 'linux' }); Object.defineProperty(process, 'arch', { value: '${arch}' });`)}`;
    return spawnSync(
      process.execPath,
      ["--import", override, join(scripts, "prepare-koed-runtime.mjs")],
      {
        encoding: "utf8",
        env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: input }
      }
    );
  };
  const invalid = join(root, "invalid");
  cpSync(source, invalid, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(invalid, "native-core-manifest.json"), "{}");
  assert.notEqual(runStage(invalid).status, 0, "bogus core marker must fail");
  rmSync(invalid, { recursive: true, force: true });
  cpSync(source, invalid, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(invalid, "postgres/bin/postgres"), "tampered");
  assert.notEqual(
    runStage(invalid).status,
    0,
    "tampered frozen core must fail"
  );
  assert.notEqual(
    runStage(source, "arm64").status,
    0,
    "frozen x64 core must not stage on arm64"
  );
  rmSync(invalid, { recursive: true, force: true });
  cpSync(source, invalid, { recursive: true, verbatimSymlinks: true });
  writeFileSync(
    join(invalid, manifest),
    JSON.stringify({ schemaVersion: 1, assets: [{ id: "bogus" }] })
  );
  rmSync(join(invalid, "native-core-manifest.json"));
  freezeCore({
    runtimeRoot: invalid,
    configuration,
    recipe: {
      schemaVersion: 1,
      kind: "core",
      configuration,
      sources: Object.fromEntries(
        ["postgres", "pgvector", "llamaCpp"].map((key) => [key, pinned[key]])
      ),
      toolchain: { cc: "fixture" },
      logic: { build: "a".repeat(64) },
      packaging: { epoch: 0 }
    }
  });
  verifyFrozenCore(invalid);
  assert.notEqual(
    runStage(invalid).status,
    0,
    "invalid asset manifest must fail even in self-consistent core"
  );
  rmSync(invalid, { recursive: true, force: true });
  cpSync(source, invalid, { recursive: true, verbatimSymlinks: true });
  rmSync(join(invalid, "native-core-manifest.json"));
  const generic = runStage(invalid);
  assert.equal(generic.status, 0, generic.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(staged, manifest), "utf8")).assets[0].version,
    "postgresql-17-pgvector-packaged"
  );
  const macPreload = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'x64' });")}`;
  const mac = spawnSync(
    process.execPath,
    ["--import", macPreload, join(scripts, "prepare-koed-runtime.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: source }
    }
  );
  assert.equal(mac.status, 0, mac.stderr);
  const macManifest = JSON.parse(readFileSync(join(staged, manifest), "utf8"));
  assert.equal(macManifest.assets[0].platform, "macos");
  assert.equal(
    macManifest.assets[0].version,
    "postgresql-17-pgvector-packaged"
  );
  const noSource = spawnSync(
    process.execPath,
    ["--import", preload, join(scripts, "prepare-koed-runtime.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: "" }
    }
  );
  assert.equal(noSource.status, 0, noSource.stderr);
  assert.deepEqual(JSON.parse(noSource.stdout).nativeAssets, []);
});

test("release guard requires the frozen CPU core and refuses bundled CUDA", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-linux-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const staged = join(root, "staged");
  for (const dir of [source, staged]) {
    mkdirSync(join(dir, "llama.cpp/cpu"), { recursive: true });
    writeFileSync(join(dir, "llama.cpp/cpu/llama-server"), "cpu", {
      mode: 0o755
    });
  }
  writeFileSync(
    join(staged, "desktop-bundle-manifest.json"),
    JSON.stringify({ target: { platform: "linux", architecture: "x64" } })
  );
  const module = await import("./validate-linux-release.mjs");
  const verified = [];
  const options = {
    runtimeRoot: staged,
    platform: "linux",
    arch: "x64",
    nativeRuntimeSource: source,
    verifyCore: (path) => verified.push(realpathSync(path)),
    runValidator: () => ({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        packagedProvider: { skipped: false, ok: true }
      }),
      stderr: ""
    })
  };
  assert.doesNotThrow(() => module.validateLinuxRelease(options));
  assert.deepEqual(verified, [realpathSync(source)]);

  // The real frozen-core check rejects a source that is not a frozen core,
  // such as the combined CPU and CUDA runtime.
  assert.throws(
    () => module.validateLinuxRelease({ ...options, verifyCore: undefined }),
    /requires the frozen native CPU core/
  );

  mkdirSync(join(staged, "llama.cpp/cuda"), { recursive: true });
  writeFileSync(join(staged, "llama.cpp/cuda/llama-server"), "cuda");
  assert.throws(
    () => module.validateLinuxRelease(options),
    /must not bundle the CUDA add-on/
  );
});
