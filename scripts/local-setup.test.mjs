import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local setup installs both required inference models", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(
    packageJson.scripts["local:setup"],
    "pnpm env:setup && pnpm build && pnpm runtime:install && pnpm models:install:embedding && pnpm models:install:privacy"
  );
  assert.equal(
    packageJson.scripts["models:install:privacy"],
    "node packages/koed-server/dist/cli.js models install --kind privacy --json"
  );
});
