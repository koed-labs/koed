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
  ["API_TOKEN_PEPPER", "generated-token-pepper"],
  ["EMBEDDING_SERVICE_TOKEN", "generated-embedding-token"]
]);

test("retains compatibility-sensitive values from an existing env", () => {
  const example = [
    "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
    "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
    "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
    "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
    "DATABASE_URL=replace_with_generated_database_url",
    "MEMORY_API_TOKEN=replace_with_token_from_pnpm_api_token_create"
  ].join("\n");
  const existing = [
    "API_DATA_ENCRYPTION_KEY=old-data-key",
    "API_TOKEN_PEPPER=old-token-pepper",
    "EMBEDDING_SERVICE_TOKEN=old-embedding-token",
    "POSTGRES_PASSWORD=old-postgres-password",
    "DATABASE_URL=postgres://koed:old-postgres-password@localhost:15432/koed",
    "MEMORY_API_TOKEN=old-memory-api-token"
  ].join("\n");

  const rendered = parseEnv(
    renderSetupEnv({ example, existing, generatedValues })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "old-data-key");
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "old-token-pepper");
  assert.equal(rendered.get("EMBEDDING_SERVICE_TOKEN"), "old-embedding-token");
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
        "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url",
        "MEMORY_API_TOKEN=replace_with_token_from_pnpm_api_token_create"
      ].join("\n"),
      existing: ["MEMORY_API_TOKEN=existing-memory-token"].join("\n"),
      generatedValues
    })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "generated-data-key");
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "generated-token-pepper");
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

test("replaces generated-secret placeholders instead of retaining them", () => {
  const rendered = parseEnv(
    renderSetupEnv({
      example: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url"
      ].join("\n"),
      existing: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
        "POSTGRES_PASSWORD=replace_with_generated_postgres_password",
        "DATABASE_URL=replace_with_generated_database_url"
      ].join("\n"),
      generatedValues
    })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "generated-data-key");
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "generated-token-pepper");
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
