import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureBuildWorkspace,
  compareBuildWorkspaceObservations
} from "./build-progress-capture.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const temporaryDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), "koed-build-progress-"));
  roots.push(root);
  return root;
};

const git = async (cwd: string, ...args: string[]) =>
  execFile("git", ["-C", cwd, ...args], { timeout: 10_000 });

const initializedRepository = async () => {
  const root = await temporaryDirectory();
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "build-progress@example.invalid");
  await git(root, "config", "user.name", "Build progress test");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "baseline");
  return root;
};

describe("Build progress workspace capture", () => {
  it("reports unavailable state for missing folders and folders outside Git", async () => {
    const root = await temporaryDirectory();
    const nonRepository = join(root, "plain-folder");
    await mkdir(nonRepository);

    await expect(
      captureBuildWorkspace(join(root, "missing"))
    ).resolves.toMatchObject({
      available: false,
      status: "Project folder unavailable",
      files: []
    });
    await expect(captureBuildWorkspace(nonRepository)).resolves.toMatchObject({
      available: false,
      status: "Git state unavailable",
      files: []
    });
  });

  it("reports a clean Project without inventing changes", async () => {
    const root = await initializedRepository();

    await expect(captureBuildWorkspace(root)).resolves.toMatchObject({
      available: true,
      status: "No changes observed",
      files: [],
      diff: { filesChanged: 0, additions: 0, deletions: 0 }
    });
  });

  it("marks baseline and later changes as observations, not Agent authorship", async () => {
    const root = await initializedRepository();
    await writeFile(join(root, "tracked.txt"), "pre-existing change\n");
    await writeFile(join(root, "new-file.txt"), "new observation\n");
    const before = await captureBuildWorkspace(root);

    await writeFile(join(root, "tracked.txt"), "observed during Job\n");
    await writeFile(join(root, "another-file.txt"), "new after baseline\n");
    const after = compareBuildWorkspaceObservations(
      before,
      await captureBuildWorkspace(root)
    );

    expect(after.status).toBe(
      "Observed while this Job was running; authorship is not established"
    );
    expect(after.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", baseline: true }),
        expect.objectContaining({ path: "new-file.txt", baseline: true }),
        expect.objectContaining({ path: "another-file.txt", baseline: false })
      ])
    );
  });
});
