import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listMatchingPullRequestProjects } from "./pull-request-projects.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const git = async (cwd: string, ...args: string[]) => {
  await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 2_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0"
    }
  });
};

const projectRecord = (input: { id: string; name: string; path: string }) => ({
  schemaVersion: 1,
  localProjectId: input.id,
  displayName: input.name,
  path: {
    cwd: input.path,
    projectRoot: input.path,
    basename: input.name,
    localPathHash: "hmac_sha256:" + "a".repeat(64)
  }
});

const metadataFile = async (koedHome: string, projects: unknown[]) => {
  const config = join(koedHome, "config");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "projects.json"),
    JSON.stringify({ schemaVersion: 3, projects }),
    { mode: 0o600 }
  );
};

describe("pull request local project matching", () => {
  it("matches exact github.com owner/repo from registered HTTPS or SSH remotes without returning paths", async () => {
    const koedHome = await mkdtemp(join(tmpdir(), "koed-pr-projects-"));
    roots.push(koedHome);
    const first = join(koedHome, "workspace", "first");
    const second = join(koedHome, "workspace", "second");
    const unregistered = join(koedHome, "workspace", "unregistered");
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
      mkdir(unregistered, { recursive: true })
    ]);
    await git(first, "init", "-b", "main");
    await git(
      first,
      "remote",
      "add",
      "origin",
      "https://github.com/Koed-Labs/Studio.git"
    );
    await git(second, "init", "-b", "main");
    await git(
      second,
      "remote",
      "add",
      "upstream",
      "git@github.com:koed-labs/studio.git"
    );
    await git(unregistered, "init", "-b", "main");
    await git(
      unregistered,
      "remote",
      "add",
      "origin",
      "https://github.com/koed-labs/studio.git"
    );
    await metadataFile(koedHome, [
      projectRecord({
        id: "lp_" + "1".repeat(32),
        name: "Studio one",
        path: first
      }),
      projectRecord({
        id: "lp_" + "2".repeat(32),
        name: "Studio two",
        path: second
      })
    ]);

    const result = await listMatchingPullRequestProjects({
      koedHome,
      repository: "KOED-LABS/Studio"
    });
    expect(result).toEqual({
      projects: [
        { id: "lp_" + "1".repeat(32), displayName: "Studio one" },
        { id: "lp_" + "2".repeat(32), displayName: "Studio two" }
      ],
      truncated: false
    });
    expect(JSON.stringify(result)).not.toContain(koedHome);
    expect(JSON.stringify(result)).not.toContain("github.com");
  });

  it("rejects malformed repositories before any git subprocess and ignores credential-bearing remotes", async () => {
    const koedHome = await mkdtemp(join(tmpdir(), "koed-pr-projects-"));
    roots.push(koedHome);
    const repository = join(koedHome, "workspace", "credentialed");
    await mkdir(repository, { recursive: true });
    await git(repository, "init", "-b", "main");
    await git(
      repository,
      "remote",
      "add",
      "origin",
      "https://alice:secret@github.com/org/repo.git"
    );
    await metadataFile(koedHome, [
      projectRecord({
        id: "lp_" + "3".repeat(32),
        name: "Credentialed",
        path: repository
      })
    ]);
    const run = vi.fn();
    await expect(
      listMatchingPullRequestProjects({
        koedHome,
        repository: "https://github.com/org/repo",
        run
      })
    ).rejects.toThrow("PullRequestProjectLookupInvalid");
    expect(run).not.toHaveBeenCalled();
    const result = await listMatchingPullRequestProjects({
      koedHome,
      repository: "org/repo"
    });
    expect(result.projects).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("uses only bounded read-only git commands with hooks and external config disabled", async () => {
    const koedHome = await mkdtemp(join(tmpdir(), "koed-pr-projects-"));
    roots.push(koedHome);
    const repository = join(koedHome, "workspace", "project");
    await mkdir(repository, { recursive: true });
    await git(repository, "init", "-b", "main");
    await metadataFile(koedHome, [
      projectRecord({
        id: "lp_" + "4".repeat(32),
        name: "Project",
        path: repository
      })
    ]);
    const calls: Array<{
      args: string[];
      options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number };
    }> = [];
    const run = vi.fn(
      async (
        _binary: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
      ) => {
        calls.push({ args, options });
        if (args.includes("--show-toplevel")) return { stdout: repository };
        if (args.at(-1) === "remote") return { stdout: "origin\n" };
        return { stdout: "https://github.com/org/repo.git\n" };
      }
    );
    const result = await listMatchingPullRequestProjects({
      koedHome,
      repository: "org/repo",
      run
    });
    expect(result.projects).toEqual([
      { id: "lp_" + "4".repeat(32), displayName: "Project" }
    ]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toContain("-c");
      expect(call.args).toContain("core.hooksPath=/dev/null");
      expect(call.options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(call.options.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(call.options.timeout).toBeLessThanOrEqual(2_000);
      expect(call.options.maxBuffer).toBeLessThanOrEqual(128 * 1024);
    }
    expect(calls.flatMap((call) => call.args).join(" ")).not.toMatch(
      /fetch|push|clone/i
    );
  });

  it("returns no project metadata if the registry is absent or invalid", async () => {
    const koedHome = await mkdtemp(join(tmpdir(), "koed-pr-projects-"));
    roots.push(koedHome);
    expect(
      await listMatchingPullRequestProjects({
        koedHome,
        repository: "org/repo"
      })
    ).toEqual({ projects: [], truncated: false });
    await metadataFile(koedHome, [
      {
        ...projectRecord({
          id: "not-a-project-id",
          name: "Invalid",
          path: resolve(koedHome, "missing")
        })
      }
    ]);
    expect(
      await readFile(join(koedHome, "config", "projects.json"), "utf8")
    ).toContain("Invalid");
    expect(
      await listMatchingPullRequestProjects({
        koedHome,
        repository: "org/repo"
      })
    ).toEqual({ projects: [], truncated: false });
  });
});
