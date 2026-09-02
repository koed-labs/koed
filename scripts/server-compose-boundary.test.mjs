import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("server Compose keeps machine telemetry behind a deny-by-default public gateway", async () => {
  const [compose, gateway] = await Promise.all([
    readFile("examples/server-compose/docker-compose.yml", "utf8"),
    readFile("examples/server-compose/public-gateway.conf", "utf8")
  ]);

  assert.match(compose, /profiles: \["public-gateway-test"\]/);
  assert.match(compose, /public-gateway\.conf:.*default\.conf:ro/);
  assert.match(gateway, /location \^~ \/internal\/\s*\{\s*return 404;/s);
  assert.match(gateway, /proxy_pass http:\/\/koed-server:3300;/);
  assert.doesNotMatch(gateway, /proxy_pass[^;]*internal\/metrics/);
});

test("server Compose maps root API Team Memory config to the API service", async () => {
  const compose = await readFile(
    "examples/server-compose/docker-compose.yml",
    "utf8"
  );

  for (const suffix of [
    "DATA_ENCRYPTION_KEY",
    "ENVELOPE_ENCRYPTION_PROVIDER",
    "MANAGED_KMS_KEY_ID",
    "MANAGED_KMS_KEY_VERSION",
    "MANAGED_KMS_ENDPOINT_URL",
    "MANAGED_KMS_AUTH_TOKEN"
  ]) {
    assert.match(
      compose,
      new RegExp(`TEAM_MEMORY_${suffix}: \\$\\{API_TEAM_MEMORY_${suffix}`)
    );
  }
});

test("server Compose requires the token pepper but no Personal API Token", async () => {
  const compose = await readFile(
    "examples/server-compose/docker-compose.yml",
    "utf8"
  );

  assert.match(
    compose,
    /KOED_DEPLOYMENT_PROFILE: \$\{KOED_DEPLOYMENT_PROFILE:-team_self_hosted\}/
  );
  assert.match(compose, /KOED_RUNTIME_MODE: external/);
  assert.match(compose, /API_TOKEN_PEPPER: \$\{API_TOKEN_PEPPER\}/);
  assert.doesNotMatch(compose, /^\s+MEMORY_API_TOKEN:/m);
});
