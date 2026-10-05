import assert from "node:assert/strict";
import {
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

const packageFixture = (root, name, dependencies, files) => {
  const packageRoot = resolve(root, "node_modules", name);
  write(
    resolve(packageRoot, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", dependencies })
  );
  write(resolve(packageRoot, "LICENSE"), `${name} licence\n`);
  for (const [path, contents] of Object.entries(files)) {
    write(resolve(packageRoot, path), contents);
  }
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
    "privacy-only",
    {
      "shared-fixture": "1.0.0",
      "@fixture/nested-only": "1.0.0"
    },
    {
      "index.js":
        'import { load } from "shared-fixture";\nimport { suffix } from "@fixture/nested-only";\nconst shared = await load();\nexport const value = `${shared.value}:privacy:${suffix}`;\n',
      "native-loader.js":
        'export const nativePath = new URL("./native.node", import.meta.url);\n',
      "native.node": "fixture native loader bytes\n",
      "node_modules/@fixture/nested-only/package.json": JSON.stringify({
        name: "@fixture/nested-only",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.js" }
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
      "shared-fixture": "1.0.0"
    },
    {
      "dist/index.js":
        'import { value } from "privacy-only";\nprocess.stdout.write(`${value}-closure-ok\\n`);\n'
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
    'import { value } from "privacy-only";\nprocess.stdout.write(`${value}-closure-ok\\n`);\n'
  );
  write(resolve(sourceRoot, "api/prompts/runtime.md"), "base prompt\n");
  write(
    resolve(sourceRoot, "privacy-service/migrations/001.sql"),
    "select 1;\n"
  );

  const result = projectRuntimeComponents({ sourceRoot, outputDir });
  const baseRoot = resolve(outputDir, "base");
  const privacyRoot = resolve(outputDir, "privacy");
  const privacyEntry = resolve(privacyRoot, "privacy-service/dist/index.js");
  const isolatedDirectory = resolve(workspace, "isolated");
  mkdirSync(isolatedDirectory);
  const child = spawnSync(process.execPath, [privacyEntry], {
    cwd: isolatedDirectory,
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /shared-dynamic:privacy:nested-closure-ok/);
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
  }
});

const assertSorted = (items) => [...items].sort();

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
            ? "import(moduleName);\\n"
            : "export {};\\n"
      }
    );
    write(resolve(sourceRoot, service, "dist/index.js"), "export {};\\n");
  }

  assert.throws(
    () =>
      projectRuntimeComponents({
        sourceRoot,
        outputDir: resolve(workspace, "components")
      }),
    /unresolved dynamic imports.*privacy-service/s
  );
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
