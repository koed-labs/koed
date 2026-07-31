import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEnv,
  renderSetupEnv,
  retainedCompatibilityKeys
} from "./setup-env-lib.mjs";

const generatedValues = new Map([
  ["POSTGRES_PASSWORD", "generated-postgres-password"],
  [
    "DATABASE_URL",
    "postgres://koed:generated-postgres-password@localhost:15432/koed"
  ],
  ["API_DATA_ENCRYPTION_KEY", "generated-data-key"],
  [
    "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
    "generated-owner-private-data-key"
  ],
  ["API_TOKEN_PEPPER", "generated-token-pepper"],
  ["API_COLLABORATION_LOCAL_BROKER_SECRET", "generated-broker-secret"],
  ["API_COLLABORATION_REALTIME_CURSOR_SECRET", "generated-cursor-secret"],
  ["EMBEDDING_SERVICE_TOKEN", "generated-embedding-token"],
  ["KOED_OPS_METRICS_TOKEN", "generated-ops-metrics-token"]
]);

test("retains compatibility-sensitive values from an existing env", () => {
  const example = [
    "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
    "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
    "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
    "API_COLLABORATION_LOCAL_BROKER_SECRET=replace_with_generated_local_broker_secret",
    "API_COLLABORATION_REALTIME_CURSOR_SECRET=replace_with_generated_realtime_cursor_secret",
    "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
    "KOED_OPS_METRICS_TOKEN=replace_with_generated_ops_metrics_token",
    "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
    "DATABASE_URL=replace_with_generated_database_url",
    "MEMORY_API_TOKEN=replace_with_token_from_pnpm_api_token_create"
  ].join("\n");
  const existing = [
    "API_DATA_ENCRYPTION_KEY=old-data-key",
    "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY=old-owner-private-data-key",
    "API_TOKEN_PEPPER=old-token-pepper",
    "API_COLLABORATION_LOCAL_BROKER_SECRET=old-broker-secret",
    "API_COLLABORATION_REALTIME_CURSOR_SECRET=old-cursor-secret",
    "EMBEDDING_SERVICE_TOKEN=old-embedding-token",
    "KOED_OPS_METRICS_TOKEN=old-ops-metrics-token",
    "POSTGRES_PASSWORD=old-postgres-password",
    "DATABASE_URL=postgres://koed:old-postgres-password@localhost:15432/koed",
    "MEMORY_API_TOKEN=old-memory-api-token"
  ].join("\n");

  const rendered = parseEnv(
    renderSetupEnv({ example, existing, generatedValues })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "old-data-key");
  assert.equal(
    rendered.get("OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY"),
    "old-owner-private-data-key"
  );
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "old-token-pepper");
  assert.equal(
    rendered.get("API_COLLABORATION_LOCAL_BROKER_SECRET"),
    "old-broker-secret"
  );
  assert.equal(
    rendered.get("API_COLLABORATION_REALTIME_CURSOR_SECRET"),
    "old-cursor-secret"
  );
  assert.equal(rendered.get("EMBEDDING_SERVICE_TOKEN"), "old-embedding-token");
  assert.equal(rendered.get("KOED_OPS_METRICS_TOKEN"), "old-ops-metrics-token");
  assert.equal(rendered.get("POSTGRES_PASSWORD"), "old-postgres-password");
  assert.equal(
    rendered.get("DATABASE_URL"),
    "postgres://koed:old-postgres-password@localhost:15432/koed"
  );
  assert.equal(rendered.get("MEMORY_API_TOKEN"), "old-memory-api-token");

  for (const key of retainedCompatibilityKeys) {
    assert.notEqual(rendered.get(key), undefined);
  }
});

test("generates missing generated secrets while preserving non-generated values", () => {
  const rendered = parseEnv(
    renderSetupEnv({
      example: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
        "API_COLLABORATION_LOCAL_BROKER_SECRET=replace_with_generated_local_broker_secret",
        "API_COLLABORATION_REALTIME_CURSOR_SECRET=replace_with_generated_realtime_cursor_secret",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "KOED_OPS_METRICS_TOKEN=replace_with_generated_ops_metrics_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url",
        "MEMORY_API_TOKEN=replace_with_token_from_pnpm_api_token_create"
      ].join("\n"),
      existing: ["MEMORY_API_TOKEN=existing-memory-token"].join("\n"),
      generatedValues
    })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "generated-data-key");
  assert.equal(
    rendered.get("OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY"),
    "generated-owner-private-data-key"
  );
  assert.notEqual(
    rendered.get("OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY"),
    rendered.get("API_DATA_ENCRYPTION_KEY")
  );
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "generated-token-pepper");
  assert.equal(
    rendered.get("KOED_OPS_METRICS_TOKEN"),
    "generated-ops-metrics-token"
  );
  assert.equal(
    rendered.get("API_COLLABORATION_LOCAL_BROKER_SECRET"),
    "generated-broker-secret"
  );
  assert.equal(
    rendered.get("API_COLLABORATION_REALTIME_CURSOR_SECRET"),
    "generated-cursor-secret"
  );
  assert.equal(
    rendered.get("EMBEDDING_SERVICE_TOKEN"),
    "generated-embedding-token"
  );
  assert.equal(
    rendered.get("POSTGRES_PASSWORD"),
    "generated-postgres-password"
  );
  assert.equal(
    rendered.get("DATABASE_URL"),
    "postgres://koed:generated-postgres-password@localhost:15432/koed"
  );
  assert.equal(rendered.get("MEMORY_API_TOKEN"), "existing-memory-token");
});

test("preserves explicit operator overrides that are not in the example", () => {
  const rendered = renderSetupEnv({
    example: [
      "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
      "KOED_MODELS_DIR="
    ].join("\n"),
    existing: [
      "POSTGRES_PASSWORD=existing-password",
      "KOED_MODELS_DIR=/srv/koed/models",
      "KOED_RUNTIME_MODE=local-personal",
      "KOED_DEPENDENCY_MODE=bundled-local",
      "KOED_EMBEDDING_MODEL_PATH=/srv/koed/custom/model.gguf"
    ].join("\n"),
    generatedValues
  });
  const values = parseEnv(rendered);

  assert.equal(values.get("POSTGRES_PASSWORD"), "existing-password");
  assert.equal(values.get("KOED_MODELS_DIR"), "/srv/koed/models");
  assert.equal(values.get("KOED_RUNTIME_MODE"), "local-personal");
  assert.equal(values.get("KOED_DEPENDENCY_MODE"), "bundled-local");
  assert.equal(
    values.get("KOED_EMBEDDING_MODEL_PATH"),
    "/srv/koed/custom/model.gguf"
  );
  assert.match(
    rendered,
    /# Operator overrides retained from the existing environment\./
  );
});

test("replaces generated-secret placeholders instead of retaining them", () => {
  const rendered = parseEnv(
    renderSetupEnv({
      example: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
        "API_COLLABORATION_LOCAL_BROKER_SECRET=replace_with_generated_local_broker_secret",
        "API_COLLABORATION_REALTIME_CURSOR_SECRET=replace_with_generated_realtime_cursor_secret",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url"
      ].join("\n"),
      existing: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=",
        "API_COLLABORATION_LOCAL_BROKER_SECRET=replace_with_generated_local_broker_secret",
        "API_COLLABORATION_REALTIME_CURSOR_SECRET=replace_with_generated_realtime_cursor_secret",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url"
      ].join("\n"),
      generatedValues
    })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "generated-data-key");
  assert.equal(
    rendered.get("OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY"),
    "generated-owner-private-data-key"
  );
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "generated-token-pepper");
  assert.equal(
    rendered.get("API_COLLABORATION_LOCAL_BROKER_SECRET"),
    "generated-broker-secret"
  );
  assert.equal(
    rendered.get("API_COLLABORATION_REALTIME_CURSOR_SECRET"),
    "generated-cursor-secret"
  );
  assert.equal(
    rendered.get("EMBEDDING_SERVICE_TOKEN"),
    "generated-embedding-token"
  );
  assert.equal(
    rendered.get("POSTGRES_PASSWORD"),
    "generated-postgres-password"
  );
  assert.equal(
    rendered.get("DATABASE_URL"),
    "postgres://koed:generated-postgres-password@localhost:15432/koed"
  );
});
