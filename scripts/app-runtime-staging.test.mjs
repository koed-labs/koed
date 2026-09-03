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
import test from "node:test";
import {
  appRuntimePackages,
  finalizeStagedAppRuntime,
  pruneSharedAppRuntimeMetadata
} from "./app-runtime-staging.mjs";

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const write = (path, content = "export {};\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

test("finalizes one symlink-free shared app-runtime graph with stable wrappers", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-shared-runtime-"));
  roots.push(root);
  for (const service of appRuntimePackages) {
    for (const entry of service.entries) {
      write(resolve(root, "node_modules", "@koed", service.package, entry));
    }
  }
  for (const entry of [
    "node_modules/@koed/api/dist/browser-approval/index.html",
    "node_modules/@koed/db/dist/index.js",
    "node_modules/@koed/db/dist/connection.js",
    "node_modules/@koed/db/dist/user-api-token-repository.js",
    "node_modules/@koed/db/drizzle/meta/_journal.json",
    "node_modules/@koed/mcp-server/dist/prompts/mcp-server-instructions.md",
    "node_modules/@koed/mcp-server/dist/prompts/codex-global-agent-guidance.md"
  ]) {
    write(resolve(root, entry), "fixture\n");
  }
  const bin = resolve(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync("../@koed/api/dist/index.js", resolve(bin, "api"));
  write(resolve(root, "node_modules", ".pnpm", "lock.yaml"));
  write(resolve(root, "package.json"), "{}\n");

  const result = finalizeStagedAppRuntime(root);
  assert.equal(result.required.length > 10, true);
  assert.equal(existsSync(bin), false);
  assert.equal(existsSync(resolve(root, "node_modules", ".pnpm")), false);
  assert.equal(existsSync(resolve(root, "package.json")), false);
  const wrapper = readFileSync(
    resolve(root, "api", "dist", "index.js"),
    "utf8"
  );
  assert.match(wrapper, /node_modules\/@koed\/api\/dist\/index\.js/);
  assert.match(wrapper, /process\.argv\[1\]/);
  const guidancePath = resolve(
    root,
    "mcp-server/dist/prompts/codex-global-agent-guidance.md"
  );
  assert.equal(readFileSync(guidancePath, "utf8"), "fixture\n");
  assert.equal(
    result.required.includes(
      "mcp-server/dist/prompts/codex-global-agent-guidance.md"
    ),
    true
  );
  pruneSharedAppRuntimeMetadata(root);
  assert.equal(readFileSync(guidancePath, "utf8"), "fixture\n");
});

test("prunes package documentation but preserves runtime MCP prompt Markdown", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-shared-runtime-"));
  roots.push(root);
  const prompt = resolve(
    root,
    "node_modules/@koed/mcp-server/dist/prompts/ai-client/worker-developer.md"
  );
  const documentation = resolve(root, "node_modules/example/README.md");
  const lockfile = resolve(root, "node_modules/example/pnpm-lock.yaml");
  const nativeSource = resolve(root, "node_modules/sharp/src/pipeline.cc");
  write(prompt, "Runtime prompt\n");
  write(documentation, "Package documentation\n");
  write(lockfile, "lockfileVersion: 9\n");
  write(nativeSource, "build-only source\n");
  write(
    resolve(root, "node_modules/example/package.json"),
    '{"name":"example","version":"1.0.0"}\n'
  );

  pruneSharedAppRuntimeMetadata(root);

  assert.equal(existsSync(prompt), true);
  assert.equal(existsSync(documentation), false);
  assert.equal(existsSync(lockfile), false);
  assert.equal(existsSync(nativeSource), false);
});

test("prunes repository placeholders and directories left empty", () => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-shared-runtime-"));
  roots.push(root);
  const packageRoot = resolve(root, "node_modules/runtime-fixture");
  const emptyTypes = resolve(packageRoot, "types/nested");
  const placeholder = resolve(packageRoot, "lib/llhttp/.gitkeep");
  const runtimeFile = resolve(packageRoot, "lib/index.js");
  mkdirSync(emptyTypes, { recursive: true });
  write(placeholder, "");
  write(runtimeFile);
  write(
    resolve(packageRoot, "package.json"),
    '{"name":"runtime-fixture","version":"1.0.0"}\n'
  );

  pruneSharedAppRuntimeMetadata(root);

  assert.equal(existsSync(resolve(packageRoot, "types")), false);
  assert.equal(existsSync(resolve(packageRoot, "lib/llhttp")), false);
  assert.equal(existsSync(runtimeFile), true);
});
