import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverProjectSourceRepos } from "./project-source-repos.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

it("discovers the canonical Git remote without storing credentials or URL query", async () => {
  const folder = mkdtempSync(join(tmpdir(), "koed-hq205-remote-"));
  folders.push(folder);
  execFileSync("git", ["init", "-q", folder]);
  execFileSync("git", [
    "-C",
    folder,
    "remote",
    "add",
    "origin",
    "https://token:secret@github.com/koed-labs/koed.git?access_token=hidden"
  ]);
  const paths = {
    configDir: join(folder, "config"),
    projectMetadataPath: join(folder, "config", "projects.json")
  } as Parameters<typeof discoverProjectSourceRepos>[0];
  const repos = await discoverProjectSourceRepos(paths, folder);
  expect(repos).toEqual([
    { name: "github.com/koed-labs/koed", uri: "github.com/koed-labs/koed" }
  ]);
  expect(JSON.stringify(repos)).not.toMatch(/token|secret|hidden|https/i);
});
