import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const dockerfile = readFileSync(
  resolve(import.meta.dirname, "../apps/api/Dockerfile"),
  "utf8"
);

test("API deployment builds MCP prompt assets before compiling and deploying the API", () => {
  const mcpBuild = dockerfile.indexOf("pnpm --filter @koed/mcp-server build");
  const apiBuild = dockerfile.indexOf("pnpm --filter @koed/api build");
  const deploy = dockerfile.indexOf("pnpm --filter @koed/api deploy");
  assert.ok(mcpBuild >= 0, "MCP build must run its prompt-copy step");
  assert.ok(mcpBuild < apiBuild && apiBuild < deploy);
});

test("API image verifies deployed route imports without a source-checkout fallback", () => {
  assert.match(
    dockerfile,
    /RUN cd \/deploy\/api && node --input-type=module -e "await import\('\.\/dist\/managed-conversations\/routes\.js'\)"/
  );
  assert.ok(
    dockerfile.indexOf("RUN cd /deploy/api") >
      dockerfile.indexOf("pnpm --filter @koed/api deploy")
  );
});
