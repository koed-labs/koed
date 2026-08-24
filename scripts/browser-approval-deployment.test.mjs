import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { SOURCE_RUNTIME_BUILD_SPEC } from "./source-runtime-build-lib.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const readRepositoryFile = (path) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

test("the server image builds API-owned browser approval assets", () => {
  const dockerfile = readRepositoryFile("packages/koed-server/Dockerfile");

  assert.match(dockerfile, /pnpm source-runtime:prepare/);
  assert.ok(SOURCE_RUNTIME_BUILD_SPEC.rootPackages.includes("@koed/api"));
  assert.ok(
    SOURCE_RUNTIME_BUILD_SPEC.requiredOutputs.includes(
      "apps/api/dist/browser-approval/index.html"
    )
  );
  assert.match(dockerfile, /EXPOSE 3300/);
  assert.doesNotMatch(dockerfile, /explorer/i);
});

test("the embedding image skips unrelated workspace lifecycle scripts", () => {
  const dockerfile = readRepositoryFile("apps/embedding-service/Dockerfile");

  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /pnpm --filter @koed\/shared build/);
  assert.match(dockerfile, /pnpm --filter @koed\/embedding-service build/);
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

test("the API keeps collaboration ciphertext on the Team provider boundary", () => {
  const buildServer = readRepositoryFile("apps/api/src/server/build-server.ts");

  assert.match(
    buildServer,
    /pool && envelopeEncryptionProvider[\s\S]*createCollaborationRepository\(pool, \{[\s\S]*envelopeEncryptionProvider,[\s\S]*teamEnvelopeEncryptionProvider/
  );
  assert.match(
    buildServer,
    /getMessageForRealtime:\s*collaborationRepository\.getMessageForRealtime/
  );
  assert.match(
    buildServer,
    /materializationRepository:\s*collaborationRealtimeMaterializationRepository/
  );
});
