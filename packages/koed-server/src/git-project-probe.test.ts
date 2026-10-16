import { execFileSync, type execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitProjectProbe } from "./git-project-probe.js";
import { discoverProjectMetadata } from "./project-metadata.js";
import type { KoedServerPaths } from "./paths.js";

const directories: string[] = [];
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-git-probe-"));
  directories.push(directory);
  return fs.realpathSync(directory);
};
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const repoFixture = () => {
  const directory = fixture();
  git(directory, "init", "--initial-branch=main");
  git(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture"
  );
  git(
    directory,
    "remote",
    "add",
    "origin",
    "git@github.com:koed-labs/example.git"
  );
  return directory;
};
const inputFor = (cwd: string) => ({
  profile: path.join(cwd, "profile"),
  cwd,
  deviceSalt: "persisted-salt"
});

describe("shared Git Project probe", () => {
  it("observes real subdirectories and worktrees and invalidates on Git configuration changes", async () => {
    const root = repoFixture();
    const subdirectory = path.join(root, "packages", "example");
    fs.mkdirSync(subdirectory, { recursive: true });
    const probe = createGitProjectProbe({ ttlMs: 60_000 });
    const main = await probe(inputFor(subdirectory));
    expect(main).toMatchObject({
      status: "git",
      root,
      branch: "main",
      commonDir: path.join(root, ".git"),
      gitDir: path.join(root, ".git")
    });
    expect(main.remotes[0]?.display).toBe("github.com/koed-labs/example");
    git(
      root,
      "remote",
      "set-url",
      "origin",
      "https://github.com/koed-labs/changed.git"
    );
    const changed = await probe(inputFor(subdirectory));
    expect(changed.remotes[0]?.display).toBe("github.com/koed-labs/changed");
    const worktree = path.join(fixture(), "checkout");
    git(root, "worktree", "add", "-b", "preview", worktree);
    const observed = await probe(inputFor(worktree));
    expect(observed).toMatchObject({
      status: "git",
      root: worktree,
      branch: "preview",
      commonDir: main.commonDir
    });
    expect(observed.gitDir).not.toBe(observed.commonDir);
    // Initializing a nested repository must invalidate a cached parent result.
    git(subdirectory, "init", "--initial-branch=nested");
    expect((await probe(inputFor(subdirectory))).root).toBe(subdirectory);
  });

  it("caches by profile, checkout, salt and configuration revision for a bounded TTL", async () => {
    let calls = 0;
    let timestamp = 0;
    const root = fixture();
    const execute = ((
      _file: string,
      args: string[],
      options: { timeout: number; maxBuffer: number },
      callback: (error: Error | null, stdout: string) => void
    ) => {
      calls++;
      expect(options).toMatchObject({ timeout: 5_000, maxBuffer: 1024 * 1024 });
      const values: Record<string, string> = {
        "rev-parse --show-toplevel": root,
        "remote -v": "",
        "branch --show-current": "main",
        "rev-parse HEAD": "fixture",
        "rev-parse --git-common-dir": ".git",
        "rev-parse --git-dir": ".git"
      };
      callback(null, values[args.slice(2).join(" ")] ?? "");
    }) as unknown as typeof execFile;
    const probe = createGitProjectProbe({
      execFile: execute,
      now: () => timestamp
    });
    const input = inputFor(root);
    const first = await probe(input);
    first.remotes.push({
      name: "injected",
      host: null,
      namespace: null,
      repo: null,
      display: null,
      fingerprint: "injected"
    });
    expect((await probe(input)).remotes).toEqual([]);
    expect(calls).toBe(6);
    await probe({ ...input, profile: path.join(root, "another-profile") });
    await probe({ ...input, deviceSalt: "other-device" });
    await probe({ ...input, configurationRevision: "changed" });
    await probe({ ...input, cwd: path.join(root, "subdirectory") });
    expect(calls).toBe(30);
    timestamp = 2_000;
    await probe(input);
    expect(calls).toBe(36);
  });

  it("distinguishes non-Git directories, failed execution, and ambiguous observations without caching failures", async () => {
    const directory = fixture();
    expect((await createGitProjectProbe()(inputFor(directory))).status).toBe(
      "non_git"
    );
    let calls = 0;
    const execute = ((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      calls++;
      callback(new Error("unavailable or timed out"), "");
    }) as unknown as typeof execFile;
    const probe = createGitProjectProbe({ execFile: execute });
    expect(await probe(inputFor(directory))).toMatchObject({
      status: "failed",
      failedCommands: ["rev-parse --show-toplevel"],
      root: null
    });
    await probe(inputFor(directory));
    expect(calls).toBe(2);
    const ambiguous = createGitProjectProbe({
      execFile: ((
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string) => void
      ) => callback(null, "/one\n/two")) as unknown as typeof execFile
    });
    expect((await ambiguous(inputFor(directory))).status).toBe("ambiguous");
  });

  it("uses one persisted profile salt across concurrent first discoveries", async () => {
    const root = repoFixture();
    const profile = fixture();
    const paths = {
      projectMetadataPath: path.join(profile, "projects.json")
    } as KoedServerPaths;
    let ids = 0;
    const deps = { randomId: () => `salt-${++ids}` };
    const [first, second] = await Promise.all([
      discoverProjectMetadata(paths, { cwd: root }, deps),
      discoverProjectMetadata(paths, { cwd: root }, deps)
    ]);
    expect(ids).toBe(2);
    expect(first.project?.localProjectId).toBe(second.project?.localProjectId);
    const rediscovered = await discoverProjectMetadata(paths, { cwd: root });
    expect(rediscovered.project?.git?.commonDirHash).toBe(
      first.project?.git?.commonDirHash
    );
  });
});
