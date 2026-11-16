import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import plist from "plist";
import { makeZip } from "./candidate-zip-test-helper.mjs";
import {
  signCandidateBundle,
  readCandidateVersion,
  validateCandidateArchive,
  validateCandidateBundle
} from "./candidate-macos-payload.mjs";

const fixture = (t, entries) => {
  const base = resolve("scratch", "candidate-payload-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = join(root, "candidate.zip");
  const data = makeZip(entries);
  writeFileSync(archive, data);
  return {
    archive,
    options: {
      sha256: createHash("sha256").update(data).digest("hex"),
      maxBytes: 1024 * 1024,
      maxEntries: 100,
      workspace: root
    }
  };
};

const minimal = [
  { name: "Koed.app/Contents/Info.plist", data: "plist" },
  { name: "Koed.app/Contents/MacOS/Koed", data: "binary", mode: 0o100755 }
];

const bundleEntries = () => {
  const runtime = "Koed.app/Contents/Resources/koed-runtime";
  const assets = ["postgres", "llama.cpp"].map((id) => ({
    id,
    platform: "macos",
    architecture: "arm64",
    version: "1",
    packagedResourcePath: id,
    installPath: id,
    sha256: "0".repeat(64),
    expectedFiles: ["bin/tool"],
    executablePaths:
      id === "postgres"
        ? {
            initdb: "bin/tool",
            pg_ctl: "bin/tool",
            psql: "bin/tool",
            pg_config: "bin/tool"
          }
        : { llama_server: "bin/tool" },
    ...(id === "llama.cpp"
      ? {
          variants: [
            {
              backend: "metal",
              executablePath: "bin/tool",
              requirements: { platform: "macos", architecture: "arm64" }
            }
          ]
        }
      : {})
  }));
  return [
    {
      name: minimal[0].name,
      data: plist.build({
        CFBundleIdentifier: "ai.koed.desktop",
        CFBundleExecutable: "Koed",
        CFBundleShortVersionString: "1.0.0",
        CFBundleVersion: "1.0.0"
      })
    },
    minimal[1],
    {
      name: `${runtime}/runtime-asset-manifest.json`,
      data: JSON.stringify({ schemaVersion: 1, assets })
    },
    {
      name: `${runtime}/desktop-bundle-manifest.json`,
      data: JSON.stringify({
        schemaVersion: 1,
        productVersion: "1.0.0",
        component: "base",
        target: { platform: "macos", architecture: "arm64" },
        files: []
      })
    },
    ...assets.map(({ id }) => ({
      name: `${runtime}/${id}/bin/tool`,
      data: "test",
      mode: 0o100755
    }))
  ];
};

test("validates identity and fixed native asset paths on a validated bundle", async (t) => {
  const { archive, options } = fixture(t, bundleEntries());
  const extracted = await validateCandidateArchive(archive, options);
  assert.equal(readCandidateVersion(extracted), "1.0.0");
  assert.throws(() => readCandidateVersion({ ...extracted }), /validated/);
  assert.doesNotThrow(() =>
    validateCandidateBundle(extracted, { expectedVersion: "1.0.0" })
  );
  assert.throws(
    () =>
      validateCandidateBundle({ ...extracted }, { expectedVersion: "1.0.0" }),
    /validated|archive/i
  );
});

test("signing uses only trusted fixed entitlements and rejects unvalidated bundles", async (t) => {
  const { archive, options } = fixture(t, bundleEntries());
  const extracted = await validateCandidateArchive(archive, options);
  const bundle = validateCandidateBundle(extracted, {
    expectedVersion: "1.0.0"
  });
  let signingOptions;
  const signer = async (options) => {
    signingOptions = options;
  };
  await signCandidateBundle(
    bundle,
    { identity: "A".repeat(40), keychain: "/tmp/trusted.keychain" },
    { sign: signer }
  );
  assert.equal(signingOptions.app, bundle.appPath);
  assert.equal(signingOptions.identityValidation, true);
  assert.equal(signingOptions.preAutoEntitlements, false);
  assert.equal(signingOptions.preEmbedProvisioningProfile, false);
  assert.match(
    signingOptions.optionsForFile(bundle.appPath).entitlements,
    /apps\/desktop\/build\/entitlements\.mac\.plist$/
  );
  assert.match(
    signingOptions.optionsForFile(`${bundle.appPath}/Contents/helper`)
      .entitlements,
    /apps\/desktop\/build\/entitlements\.mac\.inherit\.plist$/
  );
  assert.equal(
    signingOptions.optionsForFile(bundle.appPath).hardenedRuntime,
    true
  );
  await assert.rejects(
    signCandidateBundle(
      { ...bundle },
      { identity: "A".repeat(40), keychain: "/tmp/trusted.keychain" },
      { sign: signer }
    ),
    /validated/i
  );
  await assert.rejects(
    signCandidateBundle(
      bundle,
      { identity: "-", keychain: "/tmp/trusted.keychain" },
      { sign: signer }
    ),
    /identity/i
  );
});

test("refuses to sign if validated bytes change before signing", async (t) => {
  const { archive, options } = fixture(t, bundleEntries());
  const extracted = await validateCandidateArchive(archive, options);
  const bundle = validateCandidateBundle(extracted, {
    expectedVersion: "1.0.0"
  });
  writeFileSync(join(bundle.appPath, "Contents/MacOS/Koed"), "changed");
  let called = false;
  await assert.rejects(
    signCandidateBundle(
      bundle,
      { identity: "A".repeat(40), keychain: "/tmp/trusted.keychain" },
      {
        sign: async () => {
          called = true;
        }
      }
    ),
    /changed|integrity/i
  );
  assert.equal(called, false);
});

test("rejects wrong candidate identity and malicious native asset roots", async (t) => {
  const entries = bundleEntries();
  for (const mutate of [
    (items) => {
      items[0] = {
        ...items[0],
        data: plist.build({
          CFBundleIdentifier: "evil",
          CFBundleExecutable: "Koed",
          CFBundleShortVersionString: "1.0.0",
          CFBundleVersion: "1.0.0"
        })
      };
    },
    (items) => {
      const m = JSON.parse(items[2].data);
      m.assets[0].packagedResourcePath = "../../../../outside";
      items[2] = { ...items[2], data: JSON.stringify(m) };
    },
    (items) => {
      const m = JSON.parse(items[2].data);
      m.assets[0].executablePaths.tool = "../../../../outside";
      items[2] = { ...items[2], data: JSON.stringify(m) };
    }
  ]) {
    const copy = entries.map((entry) => ({ ...entry }));
    mutate(copy);
    const { archive, options } = fixture(t, copy);
    const extracted = await validateCandidateArchive(archive, options);
    assert.throws(() =>
      validateCandidateBundle(extracted, { expectedVersion: "1.0.0" })
    );
  }
});

test("rejects missing or malformed runtime executable metadata", async (t) => {
  for (const mutate of [
    (m) => {
      m.assets[0].executablePaths = {};
    },
    (m) => {
      m.assets[0].executablePaths.pg_ctl = "bin";
    },
    (m) => {
      m.assets[1].variants[0].backend = "bogus";
    },
    (m) => {
      m.assets[1].variants[0].requirements.platform = "linux";
    }
  ]) {
    const entries = bundleEntries();
    const manifest = JSON.parse(entries[2].data);
    mutate(manifest);
    entries[2] = { ...entries[2], data: JSON.stringify(manifest) };
    const { archive, options } = fixture(t, entries);
    const extracted = await validateCandidateArchive(archive, options);
    assert.throws(() =>
      validateCandidateBundle(extracted, { expectedVersion: "1.0.0" })
    );
  }
});

test("rejects excessive finalizer hash work from file-link amplification", async (t) => {
  const base = "Koed.app/Contents/Resources/koed-runtime/postgres/bin";
  const entries = [
    ...bundleEntries(),
    { name: `${base}/large`, data: "x".repeat(16 * 1024 * 1024) }
  ];
  for (let index = 0; index < 385; index++)
    entries.push({
      name: `${base}/link-${index}`,
      data: "large",
      mode: 0o120777
    });
  const { archive, options } = fixture(t, entries);
  const extracted = await validateCandidateArchive(archive, {
    ...options,
    maxBytes: 32 * 1024 * 1024,
    maxEntries: 1000
  });
  assert.throws(
    () => validateCandidateBundle(extracted, { expectedVersion: "1.0.0" }),
    /hash.*limit/i
  );
});

test("rejects in-bundle directory-link cycles before the real signer can traverse them", async (t) => {
  const entries = [
    ...bundleEntries(),
    { name: "Koed.app/Contents/loop", data: ".", mode: 0o120777 }
  ];
  const { archive, options } = fixture(t, entries);
  const extracted = await validateCandidateArchive(archive, options);
  assert.throws(
    () => validateCandidateBundle(extracted, { expectedVersion: "1.0.0" }),
    /cycle|traversal/i
  );
});

test("rejects runtime links escaping the runtime even when they remain in the app", async (t) => {
  const entries = [
    ...bundleEntries(),
    {
      name: "Koed.app/Contents/Resources/koed-runtime/link",
      data: "../../Info.plist",
      mode: 0o120777
    }
  ];
  const { archive, options } = fixture(t, entries);
  const extracted = await validateCandidateArchive(archive, options);
  assert.throws(
    () => validateCandidateBundle(extracted, { expectedVersion: "1.0.0" }),
    /link|escape/i
  );
});

test("extracts a digest-bound app while preserving executable mode", async (t) => {
  const { archive, options } = fixture(t, minimal);
  const result = await validateCandidateArchive(archive, options);
  assert.equal(
    readFileSync(join(result.appPath, "Contents/MacOS/Koed"), "utf8"),
    "binary"
  );
  assert.equal(
    statSync(join(result.appPath, "Contents/MacOS/Koed")).mode & 0o777,
    0o755
  );
});

test("preserves an in-bundle relative symlink", async (t) => {
  const { archive, options } = fixture(t, [
    ...minimal,
    { name: "Koed.app/Contents/alias", data: "Info.plist", mode: 0o120777 }
  ]);
  const result = await validateCandidateArchive(archive, options);
  const link = join(result.appPath, "Contents/alias");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), "Info.plist");
});

test("requires app identity and executable to be regular files", async (t) => {
  const entries = [
    ...minimal,
    { name: "Koed.app/Contents/real", data: "plist" }
  ];
  entries[0] = { name: minimal[0].name, data: "real", mode: 0o120777 };
  const { archive, options } = fixture(t, entries);
  await assert.rejects(
    validateCandidateArchive(archive, options),
    /regular|layout/i
  );
});

test("rejects a wrong digest before extracting", async (t) => {
  const { archive, options } = fixture(t, minimal);
  await assert.rejects(
    validateCandidateArchive(archive, { ...options, sha256: "0".repeat(64) }),
    /digest/i
  );
});

for (const name of [
  "../outside",
  "/outside",
  "Koed.app/../../outside",
  "Koed.app/Contents\\outside"
]) {
  test(`rejects unsafe archive path ${name}`, async (t) => {
    const { archive, options } = fixture(t, [
      ...minimal,
      { name, data: "unsafe" }
    ]);
    await assert.rejects(validateCandidateArchive(archive, options));
  });
}

test("rejects duplicate paths and case-insensitive collisions", async (t) => {
  for (const name of [minimal[0].name, "Koed.app/contents/info.plist"]) {
    const { archive, options } = fixture(t, [
      ...minimal,
      { name, data: "different" }
    ]);
    await assert.rejects(
      validateCandidateArchive(archive, options),
      /duplicate|collision/i
    );
  }
});

test("rejects unreasonably deep archive paths before extraction", async (t) => {
  const name = `Koed.app/${"a/".repeat(65)}file`;
  const { archive, options } = fixture(t, [...minimal, { name, data: "x" }]);
  await assert.rejects(
    validateCandidateArchive(archive, options),
    /path|depth/i
  );
});

test("rejects special entries and archive entry/size limits", async (t) => {
  const special = fixture(t, [
    ...minimal,
    { name: "Koed.app/device", mode: 0o020600 }
  ]);
  await assert.rejects(
    validateCandidateArchive(special.archive, special.options),
    /type|special/i
  );
  const tooMany = fixture(t, minimal);
  await assert.rejects(
    validateCandidateArchive(tooMany.archive, {
      ...tooMany.options,
      maxEntries: 1
    }),
    /entries/i
  );
  await assert.rejects(
    validateCandidateArchive(tooMany.archive, {
      ...tooMany.options,
      maxBytes: 10
    }),
    /size|bytes/i
  );
});

test("handles deflate while rejecting forged uncompressed sizes", async (t) => {
  const extra = {
    name: "Koed.app/Contents/compressed",
    data: "x".repeat(10000),
    deflate: true
  };
  const valid = fixture(t, [...minimal, extra]);
  const result = await validateCandidateArchive(valid.archive, valid.options);
  assert.equal(
    readFileSync(join(result.appPath, "Contents/compressed")).length,
    10000
  );
  const forged = fixture(t, [...minimal, { ...extra, declaredSize: 1 }]);
  await assert.rejects(
    validateCandidateArchive(forged.archive, forged.options),
    /bytes|size/i
  );
  const limited = fixture(t, [...minimal, extra]);
  await assert.rejects(
    validateCandidateArchive(limited.archive, {
      ...limited.options,
      maxBytes: 5000
    }),
    /size/i
  );
});

test("rejects Unicode-normalization collisions", async (t) => {
  const { archive, options } = fixture(t, [
    ...minimal,
    { name: "Koed.app/Contents/café", data: "one" },
    { name: "Koed.app/Contents/café", data: "two" }
  ]);
  await assert.rejects(validateCandidateArchive(archive, options), /collid/i);
});

test("rejects dangling, cyclic, and chained escaping symlinks", async (t) => {
  const symlink = (name, data) => ({
    name: `Koed.app/Contents/${name}`,
    data,
    mode: 0o120777
  });
  const cases = [
    [symlink("dangling", "missing")],
    [symlink("first", "second"), symlink("second", "first")],
    [symlink("first", "."), symlink("second", "first/../..")]
  ];
  for (const links of cases) {
    const { archive, options } = fixture(t, [...minimal, ...links]);
    await assert.rejects(validateCandidateArchive(archive, options));
  }
});

test("rejects escaping and ancestor symlinks before any unsafe write", async (t) => {
  for (const link of [
    { name: "Koed.app/link", data: "../../outside", mode: 0o120777 },
    { name: "Koed.app/Contents/link", data: "../..", mode: 0o120777 },
    { name: "Koed.app/Contents/evil", data: ".", mode: 0o120777 }
  ]) {
    const entries = [...minimal, link];
    if (link.name.endsWith("evil"))
      entries.push({ name: `${link.name}/file`, data: "unsafe" });
    const { archive, options } = fixture(t, entries);
    await assert.rejects(
      validateCandidateArchive(archive, options),
      /link|symlink|escape/i
    );
  }
});
