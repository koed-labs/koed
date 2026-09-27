import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const studioRoot = resolve(desktopRoot, "../studio");
const staticSource = resolve(studioRoot, "out");
const serverSource = resolve(studioRoot, "server");
const stageRoot = resolve(desktopRoot, ".studio-stage");
const serverFiles = [
  "index.mjs",
  "github.mjs",
  "pr-chat.mjs",
  "pr-chat-http.mjs",
  "personal-agents-http.mjs"
];

await stat(resolve(staticSource, "index.html"));
await stat(resolve(serverSource, "index.mjs"));
await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(staticSource, resolve(stageRoot, "out"), { recursive: true });
await mkdir(resolve(stageRoot, "server"), { recursive: true });
for (const file of serverFiles) {
  await cp(resolve(serverSource, file), resolve(stageRoot, "server", file));
}
process.stdout.write("Staged Studio static export and gateway modules.\n");
