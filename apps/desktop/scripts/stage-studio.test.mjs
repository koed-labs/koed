import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, it } from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..");
const studioRoot = resolve(desktopRoot, "../studio");
const studioDependencies = resolve(desktopRoot, "../studio/node_modules");
const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
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
  await symlink("../koed-runtime/node_modules", resolve(studio, "node_modules"), "dir");
  await cp(
    resolve(studioRoot, "main/team-collaboration-draft-store.mjs"),
    resolve(studio, "main/team-collaboration-draft-store.mjs")
  );

  const module = await import(
    pathToFileURL(resolve(studio, "main/team-collaboration-draft-store.mjs")).href
  );
  assert.equal(typeof module.createStudioTeamDraftStore, "function");
});
