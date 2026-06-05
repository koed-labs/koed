import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  collectAppEnvEntries,
  parseAppEnvExample,
  renderGeneratedBlock,
  replaceGeneratedBlock,
  syncRootEnvExample
} from "./sync-app-env-examples.mjs";

const tempDirs = [];

const tempRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-env-sync-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parses root mappings and omit directives", () => {
  const entries = parseAppEnvExample(
    [
      "# @root ROOT_DATABASE_URL",
      "DATABASE_URL=postgres://local",
      "# @root ROOT_NODE_ENV=production",
      "NODE_ENV=development",
      "# @root omit",
      "REDIS_URL=redis://local",
      "PORT=3000"
    ].join("\n"),
    { label: "API", prefix: "API" }
  );

  assert.deepEqual(
    entries.map(({ appKey, rootKey, value }) => ({ appKey, rootKey, value })),
    [
      {
        appKey: "DATABASE_URL",
        rootKey: "ROOT_DATABASE_URL",
        value: "postgres://local"
      },
      { appKey: "NODE_ENV", rootKey: "ROOT_NODE_ENV", value: "production" },
      { appKey: "PORT", rootKey: "API_PORT", value: "3000" }
    ]
  );
});

test("deduplicates identical root keys and rejects conflicting values", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "apps/a"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/b"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "apps/a/.env.example"),
    "# @root SHARED_TOKEN\nTOKEN=same\n"
  );
  fs.writeFileSync(
    path.join(root, "apps/b/.env.example"),
    "# @root SHARED_TOKEN\nTOKEN=same\n"
  );

  assert.equal(
    collectAppEnvEntries(root, [
      { label: "A", dir: "apps/a", prefix: "A" },
      { label: "B", dir: "apps/b", prefix: "B" }
    ]).length,
    1
  );

  fs.writeFileSync(
    path.join(root, "apps/b/.env.example"),
    "# @root SHARED_TOKEN\nTOKEN=different\n"
  );
  assert.throws(
    () =>
      collectAppEnvEntries(root, [
        { label: "A", dir: "apps/a", prefix: "A" },
        { label: "B", dir: "apps/b", prefix: "B" }
      ]),
    /Conflicting generated root env value/
  );
});

test("replaces only the generated block and preserves manual sections", () => {
  const next = replaceGeneratedBlock(
    [
      "# Manual before",
      "POSTGRES_DB=koed",
      "",
      "# BEGIN GENERATED APP ENV EXAMPLES",
      "OLD=value",
      "# END GENERATED APP ENV EXAMPLES",
      "",
      "# Manual after",
      "MEMORY_API_URL=http://localhost:3000",
      ""
    ].join("\n"),
    renderGeneratedBlock([
      { source: "API", appKey: "PORT", rootKey: "API_PORT", value: "3000" }
    ])
  );

  assert.match(next, /POSTGRES_DB=koed/);
  assert.match(next, /API_PORT=3000/);
  assert.doesNotMatch(next, /OLD=value/);
  assert.match(next, /MEMORY_API_URL=http:\/\/localhost:3000/);
});

test("renders shared memory config outside app sections", () => {
  const block = renderGeneratedBlock([
    {
      source: "API",
      appKey: "MEMORY_LIMIT",
      rootKey: "MEMORY_LIMIT",
      value: "20"
    },
    {
      source: "API",
      appKey: "EMBEDDING_MODEL",
      rootKey: "EMBEDDING_MODEL_KEY",
      value: "qwen3-0.6b"
    },
    {
      source: "API",
      appKey: "RERANKER_KEY",
      rootKey: "EMBEDDING_RERANKER_KEY",
      value: ""
    },
    { source: "API", appKey: "PORT", rootKey: "API_PORT", value: "3000" }
  ]);

  assert.match(
    block,
    /# Shared app config\nMEMORY_LIMIT=20\nEMBEDDING_MODEL_KEY=qwen3-0.6b\nEMBEDDING_RERANKER_KEY=\n\n# API app\nAPI_PORT=3000/
  );
});

test("sync output is deterministic", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "apps/api"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/worker"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/embedding-service"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/explorer"), { recursive: true });

  for (const app of ["api", "worker", "embedding-service", "explorer"]) {
    fs.writeFileSync(
      path.join(root, `apps/${app}/.env.example`),
      "PORT=3000\n# @root omit\nLOCAL_ONLY=1\n"
    );
  }

  fs.writeFileSync(
    path.join(root, ".env.example"),
    "# Infra\nPOSTGRES_DB=koed\n\n# Local AI-client integration values.\nMEMORY_API_URL=http://localhost:3000\n"
  );

  const first = syncRootEnvExample(root).next;
  fs.writeFileSync(path.join(root, ".env.example"), first);
  const second = syncRootEnvExample(root).next;

  assert.equal(second, first);
});
