import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEnv,
  renderSetupEnv,
  retainedCompatibilityKeys
} from "./setup-env-lib.mjs";

const generatedValues = new Map([
  ["API_DATA_ENCRYPTION_KEY", "generated-data-key"],
  ["API_TOKEN_PEPPER", "generated-token-pepper"],
  ["EMBEDDING_SERVICE_TOKEN", "generated-embedding-token"]
]);

test("retains compatibility-sensitive values from an existing env", () => {
  const example = [
    "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
    "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
    "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token",
    "GITHUB_TOKEN=replace_with_github_token_that_can_read_history_browser",
    "MEMORY_API_TOKEN=replace_with_console_created_token"
  ].join("\n");
  const existing = [
    "API_DATA_ENCRYPTION_KEY=old-data-key",
    "API_TOKEN_PEPPER=old-token-pepper",
    "EMBEDDING_SERVICE_TOKEN=old-embedding-token",
    "GITHUB_TOKEN=old-github-token",
    "MEMORY_API_TOKEN=old-memory-api-token"
  ].join("\n");

  const rendered = parseEnv(
    renderSetupEnv({ example, existing, generatedValues })
  );

  assert.equal(rendered.get("API_DATA_ENCRYPTION_KEY"), "old-data-key");
  assert.equal(rendered.get("API_TOKEN_PEPPER"), "old-token-pepper");
  assert.equal(rendered.get("EMBEDDING_SERVICE_TOKEN"), "old-embedding-token");
  assert.equal(rendered.get("GITHUB_TOKEN"), "old-github-token");
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
        "GITHUB_TOKEN=replace_with_github_token_that_can_read_history_browser",
        "MEMORY_API_TOKEN=replace_with_console_created_token"
      ].join("\n"),
      existing: [
        "GITHUB_TOKEN=existing-github-token",
        "MEMORY_API_TOKEN=existing-memory-token"
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
  assert.equal(rendered.get("GITHUB_TOKEN"), "existing-github-token");
  assert.equal(rendered.get("MEMORY_API_TOKEN"), "existing-memory-token");
});

test("replaces generated-secret placeholders instead of retaining them", () => {
  const rendered = parseEnv(
    renderSetupEnv({
      example: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=replace_with_generated_token_pepper",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token"
      ].join("\n"),
      existing: [
        "API_DATA_ENCRYPTION_KEY=replace_with_generated_32_byte_base64_key",
        "API_TOKEN_PEPPER=",
        "EMBEDDING_SERVICE_TOKEN=replace_with_generated_embedding_service_token"
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
});
