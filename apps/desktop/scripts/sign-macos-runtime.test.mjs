import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { setTimeout } from "node:timers";
import {
  createMacosSignHook,
  signMacosRuntime
} from "./sign-macos-runtime.mjs";
import { finalizeRuntimeManifests } from "./finalize-runtime-manifests.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "koed-signing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Koed.app");
  const runtime = join(app, "Contents", "Resources", "koed-runtime");
  mkdirSync(join(runtime, "postgres"), { recursive: true });
  writeFileSync(join(runtime, "postgres", "server"), "unsigned");
  writeFileSync(
    join(runtime, "runtime-asset-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: [
        {
          id: "postgres",
          packagedResourcePath: "postgres",
          version: "17",
          sha256: "old",
          expectedFiles: ["server"]
        }
      ]
    })
  );
  writeFileSync(
    join(runtime, "desktop-bundle-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      productVersion: "1.2.3",
      component: "base",
      target: { platform: "macos", architecture: "arm64" },
      files: []
    })
  );
  return { app, runtime };
};

test("one signer pass refreshes manifests after children and before outer seal", async (t) => {
  const { app, runtime } = fixture(t);
  const perFile = { entitlements: "original.plist", hardenedRuntime: true };
  const opts = {
    app,
    identity: "certificate-hash",
    keychain: "keychain",
    optionsForFile: () => perFile
  };
  let calls = 0;
  await signMacosRuntime(opts, {
    sign: async (actual) => {
      calls++;
      assert.equal(actual.identity, opts.identity);
      assert.equal(actual.keychain, opts.keychain);
      assert.equal(
        actual.optionsForFile(join(runtime, "postgres", "server")),
        perFile
      );
      writeFileSync(join(runtime, "postgres", "server"), "signed");
      assert.equal(actual.optionsForFile(app), perFile);
      const bundle = JSON.parse(
        readFileSync(join(runtime, "desktop-bundle-manifest.json"))
      );
      assert.equal(bundle.productVersion, "1.2.3");
      assert.equal(
        bundle.files.find((file) => file.path === "postgres/server").sha256,
        digest("signed")
      );
      assert(
        !bundle.files.some(
          (file) => file.path === "desktop-bundle-manifest.json"
        )
      );
      const native = JSON.parse(
        readFileSync(join(runtime, "runtime-asset-manifest.json"))
      );
      assert.notEqual(native.assets[0].sha256, "old");
      assert.equal(native.assets[0].version, "17");
      assert.equal(
        bundle.files.find((file) => file.path === "runtime-asset-manifest.json")
          .sha256,
        digest(readFileSync(join(runtime, "runtime-asset-manifest.json")))
      );
    }
  });
  assert.equal(calls, 1);
});

test("installed signer loop awaits child signing before finalizing outer manifest", async (t) => {
  const { app, runtime } = fixture(t);
  const require = createRequire(import.meta.url);
  const signerPath = join(
    dirname(require.resolve("@electron/osx-sign")),
    "sign.js"
  );
  const signerRequire = createRequire(signerPath);
  const child = join(runtime, "postgres", "server");
  const sandbox = {
    exports: {},
    __dirname: dirname(signerPath),
    require: (name) => {
      if (name !== "./util") return signerRequire(name);
      return {
        ...signerRequire(name),
        walkAsync: async () => [child],
        execFileAsync: async (_command, args) => {
          if (!args.includes("--force")) return "";
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (args.at(-1) === child)
            writeFileSync(child, "signed by installed loop");
          else {
            const manifest = JSON.parse(
              readFileSync(join(runtime, "desktop-bundle-manifest.json"))
            );
            assert.equal(
              manifest.files.find((file) => file.path === "postgres/server")
                .sha256,
              digest("signed by installed loop")
            );
          }
          return "";
        }
      };
    }
  };
  runInNewContext(
    `${readFileSync(signerPath, "utf8")}\nexports.testSign = signApplication;`,
    sandbox
  );
  await signMacosRuntime(
    { app, platform: "darwin", preAutoEntitlements: false },
    {
      sign: (opts) => sandbox.exports.testSign(opts, { name: "test" })
    }
  );
});

test("installed builder passes MacPackager without replacing delegated signer", async (t) => {
  const { app } = fixture(t);
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  builderRequire("app-builder-lib");
  const { MacPackager } = builderRequire("app-builder-lib/out/macPackager.js");
  let calls = 0;
  const hook = createMacosSignHook(async (opts) => {
    calls++;
    opts.optionsForFile(app);
  });
  const packager = {
    appInfo: { type: "module" },
    info: { getWorkspaceRoot: async () => "/" },
    sign: () => {
      throw new Error("Must not call MacPackager.sign");
    }
  };
  await MacPackager.prototype.doSign.call(
    packager,
    { app },
    { sign: hook },
    { name: "Developer ID Application: Test", hash: "test-hash" }
  );
  assert.equal(calls, 1);
});

test("missing outer callback fails closed; signer errors are not retried", async () => {
  await assert.rejects(
    signMacosRuntime({ app: "/Koed.app" }, { sign: async () => {} }),
    /outer app/
  );
  let calls = 0;
  await assert.rejects(
    signMacosRuntime(
      { app: "/Koed.app" },
      {
        sign: async () => {
          calls++;
          throw new Error("sign failure");
        }
      }
    ),
    /sign failure/
  );
  assert.equal(calls, 1);
});

test("finalizer rejects escaping symlinks and inventories signing-generated files", (t) => {
  const { runtime } = fixture(t);
  mkdirSync(join(runtime, "postgres", "_CodeSignature"));
  writeFileSync(
    join(runtime, "postgres", "_CodeSignature", "CodeResources"),
    "seal"
  );
  finalizeRuntimeManifests(runtime);
  const bundle = JSON.parse(
    readFileSync(join(runtime, "desktop-bundle-manifest.json"))
  );
  assert(
    bundle.files.some(
      (file) => file.path === "postgres/_CodeSignature/CodeResources"
    )
  );
  symlinkSync("../../../..", join(runtime, "escape"));
  assert.throws(() => finalizeRuntimeManifests(runtime), /symlink escapes/);
});
