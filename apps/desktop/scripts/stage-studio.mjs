import { cp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const studioRoot = resolve(desktopRoot, "../studio");
const staticSource = resolve(studioRoot, "out");
const serverSource = resolve(studioRoot, "server");
const mainSource = resolve(studioRoot, "main");
const stageRoot = resolve(desktopRoot, ".studio-stage");
// Copy all runtime gateway modules so a newly imported module cannot be
// omitted from the installable app. Tests remain outside the artifact.
const serverFiles = (await readdir(serverSource)).filter(
  (file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs")
);
const mainFiles = ["team-collaboration-draft-store.mjs"];

await stat(resolve(staticSource, "index.html"));
await stat(resolve(serverSource, "index.mjs"));
for (const file of serverFiles) await stat(resolve(serverSource, file));
for (const file of mainFiles) await stat(resolve(mainSource, file));
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(staticSource, resolve(stageRoot, "out"), { recursive: true });
await mkdir(resolve(stageRoot, "server"), { recursive: true });
for (const file of serverFiles) {
  await cp(resolve(serverSource, file), resolve(stageRoot, "server", file));
}
await mkdir(resolve(stageRoot, "main"), { recursive: true });
for (const file of mainFiles) {
  await cp(resolve(mainSource, file), resolve(stageRoot, "main", file));
}
// Studio is an Electron extraResource beside the packaged Koed runtime. Keep
// its bare workspace imports resolvable without copying another dependency tree.
await symlink(
  "../koed-runtime/node_modules",
  resolve(stageRoot, "node_modules"),
  "dir"
);
process.stdout.write(
  "Staged Studio static export, gateway, and Desktop modules.\n"
);
