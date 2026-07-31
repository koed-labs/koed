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
