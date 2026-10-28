import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import * as inspector from "./inspect-release-package.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { candidateFixture } from "./test-utils/release-candidate-fixture.mjs";
import { bundleControlPlane } from "./control-plane-bundle.mjs";
import { assertReleasePackageBindings } from "./inspect-release-package-bindings.mjs";

// Hand-built ustar headers isolate safety checks from any archive writer.
const tar = (entries) =>
  gzipSync(
    Buffer.concat([
      ...entries.flatMap(([name, text, type = "0"]) => {
        const header = Buffer.alloc(512);
        header.write(name);
        header.write(text.length.toString(8).padStart(11, "0"), 124);
        header.write(type, 156);
        header.fill(32, 148, 156);
        header.write(
          header
            .reduce((a, b) => a + b, 0)
            .toString(8)
            .padStart(6, "0") + "\0 ",
          148
        );
        return [
          header,
          Buffer.from(text),
          Buffer.alloc((512 - (text.length % 512)) % 512)
        ];
      }),
      Buffer.alloc(1024)
    ])
  );

test("reads bounded npm tar files without extraction or execution", () => {
  assert.equal(typeof inspector.readPackageFiles, "function");
  const files = inspector.readPackageFiles(
    tar([
      ["package/package.json", "{}"],
      ["package/bin/koed.js", "throw Error()"]
    ])
  );
  assert.equal(files.get("bin/koed.js").toString(), "throw Error()");
});
for (const [label, entries] of [
  ["traversal", [["package/../escape", "x"]]],
  ["absolute", [["/package/file", "x"]]],
  ["symlink", [["package/link", "", "2"]]],
  ["hardlink", [["package/link", "", "1"]]],
  [
    "duplicate",
    [
      ["package/file", "x"],
      ["package/file", "y"]
    ]
  ],
  [
    "conflict",
    [
      ["package/a", "x"],
      ["package/a/b", "y"]
    ]
  ]
])
  test(`rejects npm ${label}`, () =>
    assert.throws(
      () => inspector.readPackageFiles(tar(entries)),
      /archive|path|link|duplicate|conflict/i
    ));

test("statically follows real generated CLI and split control-plane consumer bindings", async () => {
  const f = candidateFixture();
  try {
    const vendorRoot = resolve(f.packageRoot, "vendor");
    await bundleControlPlane({
      repoRoot: resolve("."),
      vendorRoot,
      version: "1.2.3",
      catalog: f.catalog
    });
    const files = new Map([
      ["package.json", readFileSync(resolve(f.packageRoot, "package.json"))],
      ["bin/koed.js", readFileSync(resolve(f.packageRoot, "bin/koed.js"))]
    ]);
    for (const name of readdirSync(vendorRoot))
      files.set(`vendor/${name}`, readFileSync(resolve(vendorRoot, name)));
    assertReleasePackageBindings(files);
    const copy = new Map(files);
    const path = [...copy.keys()].find((name) =>
      copy.get(name).toString().includes("manifestCatalog: catalog")
    );
    assert.ok(path, "real bundle includes generated admission consumer");
    copy.set(
      path,
      Buffer.from(
        copy
          .get(path)
          .toString()
          .replaceAll("manifestCatalog: catalog", "manifestCatalog: null")
      )
    );
    assert.throws(
      () => assertReleasePackageBindings(copy),
      /binding|consumer|catalog/i
    );
  } finally {
    f.cleanup();
  }
});

const withRealBundle = async (run) => {
  const f = candidateFixture();
  try {
    const vendorRoot = resolve(f.packageRoot, "vendor");
    await bundleControlPlane({
      repoRoot: resolve("."),
      vendorRoot,
      version: "1.2.3",
      catalog: f.catalog
    });
    const files = new Map([
      ["package.json", readFileSync(resolve(f.packageRoot, "package.json"))],
      ["bin/koed.js", readFileSync(resolve(f.packageRoot, "bin/koed.js"))]
    ]);
    for (const name of readdirSync(vendorRoot))
      files.set(`vendor/${name}`, readFileSync(resolve(vendorRoot, name)));
    assertReleasePackageBindings(files);
    await run(files);
  } finally {
    f.cleanup();
  }
};

// Rewrite every generated admission call `verifyComponent*({ ... })`.
const rewriteAdmissionCalls = (files, rewrite) => {
  const copy = new Map(files);
  let count = 0;
  for (const [path, bytes] of copy) {
    if (!path.endsWith(".js")) continue;
    let text = bytes.toString();
    const pattern = /\b(verifyComponent(?:ManifestPin)?)\(\{/g;
    let match;
    let out = "";
    let last = 0;
    while ((match = pattern.exec(text))) {
      const start = match.index + match[0].length - 1;
      let depth = 0;
      let end = start;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        if (text[end] === "}" && --depth === 0) break;
      }
      const object = text.slice(start, end + 1);
      if (!object.includes("manifestCatalog: catalog")) continue;
      out += text.slice(last, match.index) + rewrite(match[1], object);
      last = end + 2;
      count++;
    }
    copy.set(path, Buffer.from(out + text.slice(last)));
  }
  assert.ok(count >= 3, "real bundle includes generated admission sites");
  return copy;
};

test("rejects dead decoy admission with unsupported indirect live dispatch", () =>
  withRealBundle((files) => {
    const copy = rewriteAdmissionCalls(
      files,
      (name, object) =>
        `(false ? ${name}(${object}) : [${name}][0](${object.replace("manifestCatalog: catalog", "manifestCatalog: null")}))`
    );
    assert.throws(
      () => assertReleasePackageBindings(copy),
      /binding|consumer|catalog/i
    );
  }));

test("rejects reassigned admission alias with obsolete initializer", () =>
  withRealBundle((files) => {
    const copy = rewriteAdmissionCalls(
      files,
      (name, object) =>
        `(() => { let admit = ${name}; admit = (options) => ${name}({ manifestCatalog: null }); return admit(${object}); })()`
    );
    assert.throws(
      () => assertReleasePackageBindings(copy),
      /binding|consumer|catalog|unsupported/i
    );
  }));

test("rejects root and nested CommonJS package scopes", () =>
  withRealBundle((files) => {
    const root = new Map(files);
    root.set(
      "package.json",
      Buffer.from(
        files.get("package.json").toString().replace('"module"', '"commonjs"')
      )
    );
    assert.throws(() => assertReleasePackageBindings(root), /ESM scope/i);
    const nested = new Map(files);
    nested.set("vendor/package.json", Buffer.from('{"type":"commonjs"}'));
    assert.throws(() => assertReleasePackageBindings(nested), /ESM scope/i);
    const untyped = new Map(files);
    untyped.set("vendor/package.json", Buffer.from("{}"));
    assert.throws(() => assertReleasePackageBindings(untyped), /ESM scope/i);
  }));
