/* global fetch */
import assert from "node:assert/strict";
import process from "node:process";
import { cp, mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, it } from "node:test";
import { execFileSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const studioRoot = resolve(desktopRoot, "../studio");
const studioDependencies = resolve(desktopRoot, "../studio/node_modules");
const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("resolves the Desktop draft store through the staged sibling runtime dependency link", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "koed-studio-stage-smoke-"));
  temporaryRoots.push(root);
  const resources = resolve(root, "Resources");
  const studio = resolve(resources, "studio");
  const runtime = resolve(resources, "koed-runtime");
  await mkdir(resolve(studio, "main"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  // This fixture uses workspace dependencies to model the sibling runtime
  // layout. The desktop packaging check verifies the actual copied runtime.
  await symlink(studioDependencies, resolve(runtime, "node_modules"), "dir");
  await symlink(
    "../koed-runtime/node_modules",
    resolve(studio, "node_modules"),
    "dir"
  );
  await cp(
    resolve(studioRoot, "main/team-collaboration-draft-store.mjs"),
    resolve(studio, "main/team-collaboration-draft-store.mjs")
  );

  const module = await import(
    pathToFileURL(resolve(studio, "main/team-collaboration-draft-store.mjs"))
      .href
  );
  assert.equal(typeof module.createStudioTeamDraftStore, "function");
});

it("starts the staged Studio gateway with all imported runtime modules present", async () => {
  execFileSync(
    process.execPath,
    [resolve(scriptDirectory, "stage-studio.mjs")],
    {
      cwd: desktopRoot,
      stdio: "pipe"
    }
  );
  const root = await mkdtemp(resolve(tmpdir(), "koed-studio-gateway-stage-"));
  temporaryRoots.push(root);
  const resources = resolve(root, "Resources");
  const studio = resolve(resources, "studio");
  const runtime = resolve(resources, "koed-runtime");
  await cp(resolve(desktopRoot, ".studio-stage"), studio, {
    recursive: true,
    verbatimSymlinks: true
  });
  await mkdir(runtime, { recursive: true });
  await symlink(studioDependencies, resolve(runtime, "node_modules"), "dir");
  const files = await readdir(resolve(studio, "server"));
  assert(files.includes("pull-requests-http.mjs"));
  assert(!files.some((file) => file.endsWith(".test.mjs")));
  const module = await import(
    pathToFileURL(resolve(studio, "server/index.mjs")).href
  );
  assert.equal(typeof module.createStudioServer, "function");
  const server = module.createStudioServer({
    host: "127.0.0.1",
    port: 0,
    staticDir: resolve(studio, "out")
  });
  const address = await server.start();
  try {
    const response = await fetch(`${address.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Koed/);
  } finally {
    await new Promise((resolveClose, reject) =>
      server.server.close((error) => (error ? reject(error) : resolveClose()))
    );
  }
});
