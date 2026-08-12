import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const readRepositoryFile = (path) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

test("the server image builds API-owned browser approval assets", () => {
  const dockerfile = readRepositoryFile("packages/koed-server/Dockerfile");

  assert.match(dockerfile, /pnpm --filter @koed\/api build/);
  assert.match(dockerfile, /EXPOSE 3300/);
  assert.doesNotMatch(dockerfile, /explorer/i);
});

test("server Compose exposes approval pages through koed-server only", () => {
  const compose = readRepositoryFile(
    "examples/server-compose/docker-compose.yml"
  );
  const services = compose.slice(
    compose.indexOf("services:"),
    compose.indexOf("\nvolumes:")
  );
  const serviceNames = [...services.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(
    (match) => match[1]
  );

  assert.ok(serviceNames.includes("koed-server"));
  assert.ok(!serviceNames.some((name) => /explorer|browser/i.test(name)));
  assert.match(services, /"127\.0\.0\.1:\$\{API_HOST_PORT:-3300\}:3300"/);
  assert.match(services, /dockerfile: packages\/koed-server\/Dockerfile/);
});
