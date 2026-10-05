import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { projectRuntimeComponents } from "./component-assembly.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

const packageFixture = (root, name, dependencies, files, extras = {}) => {
  const packageRoot = resolve(root, "node_modules", name);
  write(
    resolve(packageRoot, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      dependencies,
      ...extras
    })
  );
  write(resolve(packageRoot, "LICENSE"), `${name} licence\n`);
  for (const [path, contents] of Object.entries(files)) {
    write(resolve(packageRoot, path), contents);
  }
};

const minimalGraph = (
  sourceRoot,
  privacySource,
  privacyDependencies = {},
  extras = {}
) => {
  for (const [service, packageName] of [
    ["api", "@koed/api"],
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      { "dist/index.js": "export {};\n" }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }
  packageFixture(
    sourceRoot,
    "@koed/privacy-service",
    privacyDependencies,
    { "dist/index.js": privacySource },
    extras
  );
  write(resolve(sourceRoot, "privacy-service/dist/index.js"), privacySource);
};

test("projects hermetic base and privacy closures from shared production graph", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "koed-component-assembly-"));
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  const outputDir = resolve(workspace, "components");
  packageFixture(
    sourceRoot,
    "base-only",
    {},
    {
      "index.js": 'export const value = "base";\n'
    }
  );
  packageFixture(
    sourceRoot,
    "shared-fixture",
    {},
    {
      "index.js": 'export const load = () => import("./dynamic.js");\n',
      "dynamic.js": 'export const value = "shared-dynamic";\n'
    }
  );
  packageFixture(
    sourceRoot,
    "conditional-fixture",
    {},
    {
      "import.js": 'export const value = "import";\n',
      "require.cjs": 'module.exports = { value: "require" };\n'
    },
    { exports: { ".": { import: "./import.js", require: "./require.cjs" } } }
  );
  packageFixture(
    sourceRoot,
    "privacy-only",
    {
      "shared-fixture": "1.0.0",
      "@fixture/nested-only": "1.0.0"
    },
    {
      "index.js":
        'import { load } from "shared-fixture";\nimport { suffix } from "@fixture/nested-only";\nconst shared = await load();\nexport const value = `${shared.value}:privacy:${suffix}`;\n',
      "dist/relative.js": 'import "../..//privacy-only/index.js";\n',
      "native-loader.js":
        'export const nativePath = new URL("./native.node", import.meta.url);\n',
      "native.node": "fixture native loader bytes\n",
      "node_modules/@fixture/nested-only/package.json": JSON.stringify({
        name: "@fixture/nested-only",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": {
            node: { import: "./index.js", default: "./index.js" }
          }
        }
      }),
      "node_modules/@fixture/nested-only/LICENSE":
        "nested dependency licence\n",
      "node_modules/@fixture/nested-only/index.js":
        'export const suffix = "nested";\n'
    }
  );
  packageFixture(
    sourceRoot,
    "@koed/privacy-service",
    {
      "privacy-only": "1.0.0",
      "shared-fixture": "1.0.0",
      "conditional-fixture": "1.0.0"
    },
    {
      "dist/index.js":
        'import { createRequire } from "node:module";\nimport { value as importValue } from "conditional-fixture";\nimport { value } from "privacy-only";\nconst require = createRequire(import.meta.url);\nconst requireValue = require("conditional-fixture").value;\nprocess.stdout.write(`${value}:${importValue}:${requireValue}-closure-ok\n`);\n'
    }
  );
  packageFixture(
    sourceRoot,
    "@koed/api",
    { "base-only": "1.0.0", "shared-fixture": "1.0.0" },
    {
      "dist/index.js": "export {};\n"
    }
  );
  for (const [service, packageName] of [
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      { "dist/index.js": "export {};\n" }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }
  write(resolve(sourceRoot, "api/dist/index.js"), 'import "base-only";\n');
  write(
    resolve(sourceRoot, "privacy-service/dist/index.js"),
    'import { createRequire } from "node:module";\nimport { value as importValue } from "conditional-fixture";\nimport { value } from "privacy-only";\nconst require = createRequire(import.meta.url);\nconst requireValue = require("conditional-fixture").value;\nprocess.stdout.write(`${value}:${importValue}:${requireValue}-closure-ok\n`);\n'
  );
  write(resolve(sourceRoot, "api/prompts/runtime.md"), "base prompt\n");
  write(
    resolve(sourceRoot, "privacy-service/migrations/001.sql"),
    "select 1;\n"
  );

  const result = projectRuntimeComponents({ sourceRoot, outputDir });
  const baseRoot = resolve(outputDir, "base");
  const privacyRoot = resolve(outputDir, "privacy");
  const relocatedRoot = mkdtempSync(
    resolve(tmpdir(), "koed-relocated-components-")
  );
  roots.push(relocatedRoot);
  const relocatedOutput = resolve(relocatedRoot, "components");
  cpSync(outputDir, relocatedOutput, { recursive: true });
  const privacyEntry = resolve(
    relocatedOutput,
    "privacy/privacy-service/dist/index.js"
  );
  const isolatedDirectory = resolve(workspace, "isolated");
  mkdirSync(isolatedDirectory);
  const child = spawnSync(process.execPath, [privacyEntry], {
    cwd: isolatedDirectory,
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(
    child.stdout,
    /shared-dynamic:privacy:nested:import:require-closure-ok/
  );
  assert.equal(result.baseRoot, baseRoot);
  assert.equal(result.privacyRoot, privacyRoot);
  assert.ok(
    existsSync(resolve(baseRoot, "node_modules/base-only/package.json"))
  );
  assert.ok(
    existsSync(resolve(privacyRoot, "node_modules/privacy-only/package.json"))
  );
  assert.ok(
    existsSync(resolve(baseRoot, "node_modules/shared-fixture/package.json"))
  );
  assert.ok(
    existsSync(resolve(privacyRoot, "node_modules/shared-fixture/package.json"))
  );
  assert.ok(!existsSync(resolve(baseRoot, "privacy-service/dist/index.js")));
  assert.ok(
    existsSync(resolve(privacyRoot, "privacy-service/migrations/001.sql"))
  );
  assert.ok(
    existsSync(
      resolve(privacyRoot, "node_modules/privacy-only/native-loader.js")
    )
  );
  assert.ok(
    existsSync(resolve(privacyRoot, "node_modules/privacy-only/native.node"))
  );
  assert.ok(
    existsSync(
      resolve(
        privacyRoot,
        "node_modules/privacy-only/node_modules/@fixture/nested-only/package.json"
      )
    )
  );
  assert.deepEqual(result.baseRequired, assertSorted(result.baseRequired));
  assert.deepEqual(
    result.privacyRequired,
    assertSorted(result.privacyRequired)
  );
  for (const componentRoot of [baseRoot, privacyRoot]) {
    const inventory = JSON.parse(
      readFileSync(resolve(componentRoot, "third-party-notices.json"), "utf8")
    );
    assert.ok(
      inventory.packages.every((entry) => entry.files.includes("LICENSE"))
    );
    const graph = JSON.parse(
      readFileSync(
        resolve(componentRoot, "component-assembly-inventory.json"),
        "utf8"
      )
    );
    assert.equal(graph.verifiedLiteralEdges, true);
    assert.match(graph.auditScope, /TypeScript JavaScript AST/);
    assert.deepEqual(graph.unresolvedRuntimeEdges, []);
    assert.ok(graph.maintainedRuntimeEdges.every((edge) => edge.owner));
    assert.ok(graph.scanLimits.length > 0);
  }
});

const assertSorted = (items) => [...items].sort();

test("rejects missing literal imports and package edges", () => {
  const workspace = mkdtempSync(
    resolve(tmpdir(), "koed-component-missing-import-")
  );
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  for (const [service, packageName] of [
    ["api", "@koed/api"],
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"],
    ["privacy-service", "@koed/privacy-service"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      {
        "dist/index.js":
          service === "privacy-service"
            ? 'import "missing-runtime-edge";\nimport "./missing-relative.js";\nrequire("missing-" + "computed");\n'
            : "export {};\n"
      }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /unresolved runtime edges[\s\S]*missing-runtime-edge/
  );
});

test("rejects template dynamic imports and unresolved native/assets", () => {
  const workspace = mkdtempSync(
    resolve(tmpdir(), "koed-component-unknown-edge-")
  );
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  for (const [service, packageName] of [
    ["api", "@koed/api"],
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"],
    ["privacy-service", "@koed/privacy-service"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      {
        "dist/index.js":
          service === "privacy-service"
            ? 'const ext = ".js"; await import(`./unknown${ext}`);\n' +
              'const { createRequire } = await import("node:module");\n' +
              'createRequire(import.meta.url)("./missing.node");\n' +
              'new URL("./missing.prompt", import.meta.url);\n'
            : "export {};\n"
      }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /unresolved runtime edges.*(?:non-literal|asset)/is
  );
});

test("rejects symlinked source root and scoped package ancestors", () => {
  const workspace = mkdtempSync(
    resolve(tmpdir(), "koed-component-ancestor-link-")
  );
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  const realRoot = resolve(workspace, "real-runtime");
  packageFixture(
    realRoot,
    "@koed/api",
    {},
    { "dist/index.js": "export {};\n" }
  );
  symlinkSync(realRoot, sourceRoot);

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /unsupported entries/i
  );

  const scopedSource = resolve(workspace, "scoped-runtime");
  const externalScope = resolve(workspace, "external-scope");
  packageFixture(
    externalScope,
    "@koed/api",
    {},
    { "dist/index.js": "export {};\n" }
  );
  mkdirSync(resolve(scopedSource, "node_modules"), { recursive: true });
  symlinkSync(
    resolve(externalScope, "node_modules/@koed"),
    resolve(scopedSource, "node_modules/@koed")
  );
  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot: scopedSource,
        outputDir: resolve(workspace, "scoped-components")
      }),
    /unsupported entries/i
  );
});

test("fails closed on unowned non-literal dynamic imports", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "koed-component-dynamic-"));
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  for (const [service, packageName] of [
    ["api", "@koed/api"],
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"],
    ["privacy-service", "@koed/privacy-service"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      {
        "dist/index.js":
          service === "privacy-service"
            ? "import(moduleName);\n"
            : "export {};\n"
      }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /unresolved runtime edges.*privacy-service/s
  );
});

test("requires concrete closure ownership for optional native platform probes", () => {
  const target = "@msgpackr-extract/msgpackr-extract-darwin-arm64";
  const createGraph = (declaredTarget, argument = "platformPackage") => {
    const workspace = mkdtempSync(
      resolve(tmpdir(), "koed-component-optional-native-")
    );
    roots.push(workspace);
    const sourceRoot = resolve(workspace, "shared-runtime");
    minimalGraph(sourceRoot, "export {};\n", {
      "msgpackr-extract": "1.0.0"
    });
    packageFixture(
      sourceRoot,
      "msgpackr-extract",
      { "node-gyp-build-optional-packages": "1.0.0" },
      { "index.js": "export {};\n" },
      { optionalDependencies: declaredTarget ? { [target]: "1.0.0" } : {} }
    );
    packageFixture(
      sourceRoot,
      "node-gyp-build-optional-packages",
      {},
      {
        "node-gyp-build.js": `require('module').createRequire(url.pathToFileURL(path.join(dir, 'package.json'))).resolve(${argument});\n`
      }
    );
    if (declaredTarget)
      packageFixture(sourceRoot, target, {}, { "index.js": "export {};\n" });
    return { sourceRoot, outputDir: resolve(workspace, "components") };
  };
  const owned = createGraph(true);
  projectRuntimeComponents(owned);
  assert.ok(
    existsSync(
      resolve(
        owned.outputDir,
        "privacy/node_modules/@msgpackr-extract/msgpackr-extract-darwin-arm64/index.js"
      )
    )
  );
  const inventory = JSON.parse(
    readFileSync(
      resolve(owned.outputDir, "privacy/component-assembly-inventory.json"),
      "utf8"
    )
  );
  assert.ok(
    inventory.maintainedRuntimeEdges.some(
      ({ owner, rationale, limit }) =>
        owner === "optional-native-platform-package-probe" &&
        rationale.includes("platform/architecture package") &&
        limit.includes("declares it optional")
    )
  );
  assert.throws(
    () => projectRuntimeComponents(createGraph(false)),
    /no declared msgpackr-extract platform package in closure/
  );
  assert.throws(
    () => projectRuntimeComponents(createGraph(true, "userPackage")),
    /unresolved runtime edges/s
  );
});

test("accepts only maintained Pino and Claude SDK caller-selected runtime probes", () => {
  const workspace = mkdtempSync(
    resolve(tmpdir(), "koed-component-maintained-probes-")
  );
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  minimalGraph(sourceRoot, "export {};\n", {
    pino: "1.0.0",
    "@anthropic-ai/claude-agent-sdk": "1.0.0"
  });
  packageFixture(
    sourceRoot,
    "pino",
    {},
    {
      "lib/transport.js":
        'const { createRequire } = require("module"); function fixTarget(origin, context) { return createRequire(context).resolve(origin); }\n'
    }
  );
  packageFixture(
    sourceRoot,
    "@anthropic-ai/claude-agent-sdk",
    {},
    {
      "sdk.mjs":
        'import { createRequire as IMe } from "module"; const yr = fileURLToPath(import.meta.url); const Xr = IMe(yr); const targets = $M((mi) => Xr.resolve(mi));\n'
    }
  );

  const outputDir = resolve(workspace, "components");
  projectRuntimeComponents({ sourceRoot, outputDir });
  const inventory = JSON.parse(
    readFileSync(
      resolve(outputDir, "privacy/component-assembly-inventory.json"),
      "utf8"
    )
  );
  assert.ok(
    inventory.maintainedRuntimeEdges.some(
      ({ owner, detail, call, argumentText, rationale, limit }) =>
        owner === "pino-caller-selected-transport-resolver" &&
        detail.includes("createRequire(context)") &&
        call === "createRequire" &&
        argumentText === "context" &&
        rationale.includes("caller-owned, not bundled") &&
        limit.includes("separately declared and verified")
    )
  );
  assert.ok(
    inventory.maintainedRuntimeEdges.some(
      ({ owner, detail, call, argumentText, limit }) =>
        owner === "pino-caller-selected-transport-resolver" &&
        detail.includes("require.resolve(origin)") &&
        call === "createRequire(context).resolve" &&
        argumentText === "origin" &&
        limit.includes("does not include arbitrary caller targets")
    )
  );
  assert.ok(
    inventory.maintainedRuntimeEdges.some(
      ({ owner, detail, call, argumentText, rationale, limit }) =>
        owner === "claude-sdk-optional-platform-cli-probe" &&
        detail.includes("require.resolve(mi)") &&
        call === "Xr.resolve" &&
        argumentText === "mi" &&
        rationale.includes("fixed platform/architecture") &&
        limit.includes("arbitrary require targets remain unresolved")
    )
  );
  assert.ok(
    inventory.scanLimits.some((limit) =>
      limit.includes("configured targets require separate closure ownership")
    )
  );
});

test("rejects altered Pino and Claude SDK loader expressions", () => {
  const cases = [
    {
      packageName: "pino",
      file: "lib/transport.js",
      source:
        'const { createRequire } = require("module"); function fixTarget(origin, otherContext) { return createRequire(otherContext).resolve(origin); }\n',
      dependencies: { pino: "1.0.0" }
    },
    {
      packageName: "pino",
      file: "lib/transport.js",
      source:
        'const { createRequire } = require("module"); function fixTarget(runtimeTarget, context) { return createRequire(context).resolve(runtimeTarget); }\n',
      dependencies: { pino: "1.0.0" }
    },
    {
      packageName: "@anthropic-ai/claude-agent-sdk",
      file: "sdk.mjs",
      source:
        'import { createRequire as IMe } from "module"; const Xr = IMe(otherContext); const targets = $M((other) => Xr.resolve(other));\n',
      dependencies: { "@anthropic-ai/claude-agent-sdk": "1.0.0" }
    }
  ];
  for (const item of cases) {
    const workspace = mkdtempSync(
      resolve(tmpdir(), "koed-component-unowned-probe-")
    );
    roots.push(workspace);
    const sourceRoot = resolve(workspace, "shared-runtime");
    minimalGraph(sourceRoot, "export {};\n", item.dependencies);
    packageFixture(
      sourceRoot,
      item.packageName,
      {},
      {
        [item.file]: item.source
      }
    );
    assert.throws(
      () =>
        projectRuntimeComponents({
          sourceRoot,
          outputDir: resolve(workspace, "components")
        }),
      /unresolved runtime edges/s
    );
  }
});

test("rejects unresolved createRequire calls, including direct and aliased forms", async (t) => {
  const cases = [
    [
      "direct createRequire call",
      'import { createRequire } from "node:module"; createRequire(import.meta.url)("./missing.node");'
    ],
    [
      "aliased createRequire call",
      'import { createRequire as makeRequire } from "node:module"; const localRequire = makeRequire(import.meta.url); localRequire("./missing.node");'
    ],
    [
      "namespace createRequire call",
      'import * as module from "node:module"; module.createRequire(import.meta.url)("./missing.node");'
    ],
    [
      "direct createRequire resolve call",
      'import { createRequire } from "node:module"; createRequire(import.meta.url).resolve("./missing.node");'
    ]
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => {
      const workspace = mkdtempSync(
        resolve(tmpdir(), "koed-component-create-require-")
      );
      roots.push(workspace);
      const sourceRoot = resolve(workspace, "shared-runtime");
      minimalGraph(sourceRoot, source);
      assert.throws(
        () =>
          projectRuntimeComponents({
            sourceRoot,
            outputDir: resolve(workspace, "components")
          }),
        /unresolved runtime edges.*missing\.node/s
      );
    });
  }
});

test("uses loader-aware Node exports and rejects blocked or missing subpaths", async (t) => {
  const cases = [
    {
      name: "require condition wins even when import condition appears first",
      source: 'const edge = require("edge-fixture");',
      exports: { ".": { import: "./import.js", require: "./require.js" } },
      files: { "require.js": "module.exports = {};\n" }
    },
    {
      name: "root string export resolves",
      source: 'import "edge-fixture";',
      exports: "./entry.js",
      files: { "entry.js": "export {};\n" }
    },
    {
      name: "blocked subpath does not fall back to filesystem",
      source: 'import "edge-fixture/private.js";',
      exports: { ".": "./index.js" },
      files: { "index.js": "export {};\n", "private.js": "export {};\n" }
    },
    {
      name: "missing subpath does not fall back to filesystem",
      source: 'import "edge-fixture/private.js";',
      exports: { ".": "./index.js", "./public.js": "./public.js" },
      files: { "index.js": "export {};\n", "private.js": "export {};\n" }
    }
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const workspace = mkdtempSync(
        resolve(tmpdir(), "koed-component-exports-")
      );
      roots.push(workspace);
      const sourceRoot = resolve(workspace, "shared-runtime");
      minimalGraph(sourceRoot, item.source, { "edge-fixture": "1.0.0" });
      packageFixture(sourceRoot, "edge-fixture", {}, item.files, {
        exports: item.exports
      });
      const shouldReject =
        item.name.includes("blocked") || item.name.includes("missing");
      if (shouldReject) {
        assert.throws(
          () =>
            projectRuntimeComponents({
              sourceRoot,
              outputDir: resolve(workspace, "components")
            }),
          /unresolved runtime edges.*edge-fixture/s
        );
      } else {
        assert.doesNotThrow(() =>
          projectRuntimeComponents({
            sourceRoot,
            outputDir: resolve(workspace, "components")
          })
        );
      }
    });
  }
});

test("rejects relative, absolute, and package-import targets outside copied ownership", async (t) => {
  const cases = [
    ["relative escape", 'import "../../../../outside.js";', {}],
    ["absolute target", 'import "/tmp/koed-assembly-outside.js";', {}],
    [
      "package import escape",
      'import "#outside";',
      { imports: { "#outside": "../../../outside.js" } }
    ]
  ];
  for (const [name, source, extras] of cases) {
    await t.test(name, () => {
      const workspace = mkdtempSync(
        resolve(tmpdir(), "koed-component-ownership-")
      );
      roots.push(workspace);
      const sourceRoot = resolve(workspace, "shared-runtime");
      minimalGraph(sourceRoot, source, {}, extras);
      write(resolve(sourceRoot, "outside.js"), "export {};\n");
      assert.throws(
        () =>
          projectRuntimeComponents({
            sourceRoot,
            outputDir: resolve(workspace, "components")
          }),
        /unresolved runtime edges.*(?:outside|absolute|escapes|ownership)/is
      );
    });
  }
});

test("rejects external or escaping symlinks in projected package trees", () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "koed-component-links-"));
  roots.push(workspace);
  const sourceRoot = resolve(workspace, "shared-runtime");
  for (const [service, packageName] of [
    ["api", "@koed/api"],
    ["worker", "@koed/worker"],
    ["embedding-service", "@koed/embedding-service"],
    ["mcp-server", "@koed/mcp-server"],
    ["koed-server", "@koed-labs/server"],
    ["privacy-service", "@koed/privacy-service"]
  ]) {
    packageFixture(
      sourceRoot,
      packageName,
      {},
      { "dist/index.js": "export {};\n" }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\n");
  }
  symlinkSync(
    workspace,
    resolve(sourceRoot, "node_modules/@koed/privacy-service/escape")
  );

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /symlink|unsupported entr/i
  );
});
