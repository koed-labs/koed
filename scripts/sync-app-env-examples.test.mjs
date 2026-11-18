import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseEnv, renderSetupEnv } from "./setup-env-lib.mjs";
import {
  collectAppEnvEntries,
  appEnvSources,
  parseAppEnvExample,
  renderGeneratedBlock,
  replaceGeneratedBlock,
  syncRootEnvExample
} from "./sync-app-env-examples.mjs";

const tempDirs = [];

const tempRoot = () => {
  const scratch = path.resolve(import.meta.dirname, "../scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "koed-env-sync-"));
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
      "PORT=3300"
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
      { appKey: "PORT", rootKey: "API_PORT", value: "3300" }
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
      "MEMORY_API_URL=http://localhost:3300",
      ""
    ].join("\n"),
    renderGeneratedBlock([
      { source: "API", appKey: "PORT", rootKey: "API_PORT", value: "3300" }
    ])
  );

  assert.match(next, /POSTGRES_DB=koed/);
  assert.match(next, /API_PORT=3300/);
  assert.doesNotMatch(next, /OLD=value/);
  assert.match(next, /MEMORY_API_URL=http:\/\/localhost:3300/);
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
      appKey: "SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS",
      rootKey: "SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS",
      value: "300000"
    },
    { source: "API", appKey: "PORT", rootKey: "API_PORT", value: "3300" }
  ]);

  assert.match(
    block,
    /# Shared app config\nMEMORY_LIMIT=20\nEMBEDDING_MODEL_KEY=qwen3-0.6b\nSEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS=300000\n\n# API app\nAPI_PORT=3300/
  );
});

test("preserves explicitly shared Team Memory encryption names", () => {
  const entries = parseAppEnvExample(
    [
      "# @root TEAM_MEMORY_DATA_ENCRYPTION_KEY",
      "TEAM_MEMORY_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
      "# @root TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER",
      "TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER="
    ].join("\n"),
    { label: "API", prefix: "API" }
  );

  assert.deepEqual(
    entries.map(({ rootKey }) => rootKey),
    [
      "TEAM_MEMORY_DATA_ENCRYPTION_KEY",
      "TEAM_MEMORY_ENVELOPE_ENCRYPTION_PROVIDER"
    ]
  );
});

test("sync output is deterministic", () => {
  const root = tempRoot();
  for (const source of appEnvSources) {
    fs.mkdirSync(path.join(root, source.dir), { recursive: true });
    fs.writeFileSync(
      path.join(root, source.dir, ".env.example"),
      "PORT=3300\n# @root omit\nLOCAL_ONLY=1\n"
    );
  }

  fs.writeFileSync(
    path.join(root, ".env.example"),
    "# Infra\nPOSTGRES_DB=koed\n\n# Local AI-client integration values.\nMEMORY_API_URL=http://localhost:3300\n"
  );

  const first = syncRootEnvExample(root).next;
  fs.writeFileSync(path.join(root, ".env.example"), first);
  const second = syncRootEnvExample(root).next;

  assert.equal(second, first);
});

test("Desktop examples sync public account defaults with DESKTOP_ACCOUNT root names", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const entries = collectAppEnvEntries(root).filter(
    (entry) => entry.source === "Desktop"
  );
  assert.deepEqual(
    entries.map(({ appKey, rootKey, value }) => ({ appKey, rootKey, value })),
    [
      {
        appKey: "KOED_ACCOUNT_ENABLED",
        rootKey: "DESKTOP_ACCOUNT_ENABLED",
        value: "false"
      },
      {
        appKey: "KOED_ACCOUNT_CLIENT_ID",
        rootKey: "DESKTOP_ACCOUNT_CLIENT_ID",
        value: ""
      },
      {
        appKey: "KOED_ACCOUNT_ENVIRONMENT",
        rootKey: "DESKTOP_ACCOUNT_ENVIRONMENT",
        value: "staging"
      },
      {
        appKey: "KOED_ACCOUNT_LOGIN_MODE",
        rootKey: "DESKTOP_ACCOUNT_LOGIN_MODE",
        value: "forwarder"
      },
      {
        appKey: "KOED_ACCOUNT_FORWARDER_URL",
        rootKey: "DESKTOP_ACCOUNT_FORWARDER_URL",
        value: ""
      }
    ]
  );
});

test("env setup preserves Desktop opt-in and adds missing prefixed settings", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const example = syncRootEnvExample(root).next;
  const existing =
    "DESKTOP_ACCOUNT_ENABLED=true\nDESKTOP_ACCOUNT_CLIENT_ID=client_developerfixture\nDESKTOP_ACCOUNT_FORWARDER_URL=https://login.example.test/desktop/callback\n";
  const values = parseEnv(
    renderSetupEnv({ example, existing, generatedValues: new Map() })
  );
  assert.equal(values.get("DESKTOP_ACCOUNT_ENABLED"), "true");
  assert.equal(
    values.get("DESKTOP_ACCOUNT_CLIENT_ID"),
    "client_developerfixture"
  );
  assert.equal(values.get("DESKTOP_ACCOUNT_ENVIRONMENT"), "staging");
  assert.equal(values.get("DESKTOP_ACCOUNT_LOGIN_MODE"), "forwarder");
  assert.equal(
    values.get("DESKTOP_ACCOUNT_FORWARDER_URL"),
    "https://login.example.test/desktop/callback"
  );
});

test("generated root defaults leave Desktop processing preferences editable", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const keys = new Set(
    collectAppEnvEntries(root).map((entry) => entry.rootKey)
  );
  for (const key of [
    "KOED_HARDWARE_ACCELERATION",
    "KOED_EMBEDDING_ACCELERATION",
    "PRIVACY_RUNTIME_PROVIDER"
  ]) {
    assert.equal(
      keys.has(key),
      false,
      `${key} must be an explicit Operator override`
    );
  }
});
