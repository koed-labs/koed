import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  discoverProjectMetadata,
  createNamedProject,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { repositoryScopeId } from "@koed/shared";
import { pinRepositoryRecallContext } from "../src/repository-recall-context.js";
import { resolveRequestedProjectRoot } from "../src/repository-recall-context.js";

it("pins a named local Project without requiring a directory or inheriting cwd Team routing", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-named-recall-")
  );
  try {
    const environment = { KOED_HOME: directory };
    const named = createNamedProject(
      resolveKoedServerPaths(environment),
      "Planning"
    );
    const caller = { cwd: "/unavailable/checkout" };
    const scope = repositoryScopeId(named.repository);
    for (const project_id of [named.id, scope]) {
      const pinned = await pinRepositoryRecallContext(
        { search_domain: "project", project_id },
        caller,
        environment
      );
      expect(pinned).toMatchObject({
        project_id: scope,
        repository_context: named.repository
      });
      expect(
        resolveRequestedProjectRoot(pinned, caller, environment)
      ).toBeUndefined();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("pins the requested Project before acceptance and preserves it through cwd, anchor and branch changes", async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "koed-pinned-recall-"))
  );
  try {
    const cwd = path.join(directory, "x");
    const other = path.join(directory, "y");
    const subdirectory = path.join(cwd, "package");
    fs.mkdirSync(subdirectory, { recursive: true });
    fs.mkdirSync(other);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", "https://github.com/example/x.git");
    const env = { KOED_HOME: path.join(directory, "profile") };
    const pinned = await pinRepositoryRecallContext(
      { search_domain: "project" } as {
        search_domain: string;
        project_id?: string;
        repository_context?: import("@koed/shared").RepositoryIdentity;
      },
      { cwd: subdirectory },
      env
    );
    expect(pinned.repository_context).toMatchObject({
      kind: "portable_repository",
      root: cwd,
      branch: "main"
    });
    expect(pinned.project_id).toBe(
      repositoryScopeId(pinned.repository_context!)
    );
    git(
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/changed.git"
    );
    git("symbolic-ref", "HEAD", "refs/heads/preview");
    expect(
      await pinRepositoryRecallContext(pinned, { cwd: other }, env)
    ).toEqual(pinned);
    const requested = (
      await discoverProjectMetadata(resolveKoedServerPaths(env), { cwd: other })
    ).project!;
    const explicit = await pinRepositoryRecallContext(
      { search_domain: "project", project_id: requested.localProjectId },
      { cwd: subdirectory },
      env
    );
    expect(explicit.repository_context?.root).toBe(other);
    expect(explicit.project_id).not.toBe(pinned.project_id);
    await expect(
      pinRepositoryRecallContext(
        { search_domain: "project", project_id: "missing-project" },
        { cwd },
        env
      )
    ).rejects.toThrow("could not be resolved");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("pins a repository scope to a live checkout whose identity still matches", async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "koed-live-checkout-"))
  );
  try {
    const env = { KOED_HOME: path.join(directory, "profile") };
    const paths = resolveKoedServerPaths(env);
    const checkout = (name: string, remote: string) => {
      const root = path.join(directory, name);
      fs.mkdirSync(root, { recursive: true });
      execFileSync("git", ["-C", root, "init", "--initial-branch=main"]);
      execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
      return root;
    };
    const first = checkout("first", "https://github.com/example/shared.git");
    const second = checkout("second", "https://github.com/example/shared.git");
    const firstIdentity = (
      await discoverProjectMetadata(paths, { cwd: first })
    ).project!.repository!;
    await discoverProjectMetadata(paths, { cwd: second });
    const scope = repositoryScopeId(firstIdentity);
    const pin = () =>
      pinRepositoryRecallContext(
        { search_domain: "project", project_id: scope },
        { cwd: directory },
        env
      );

    fs.rmSync(first, { recursive: true, force: true });
    expect(
      resolveRequestedProjectRoot(
        { project_id: scope },
        { cwd: directory },
        env
      )
    ).toBe(second);
    expect(await pin()).toMatchObject({
      project_id: scope,
      repository_context: { root: second }
    });

    // A recreated checkout at the old path no longer has the requested identity.
    checkout("first", "https://github.com/example/other.git");
    expect((await pin()).repository_context?.root).toBe(second);

    fs.rmSync(second, { recursive: true, force: true });
    await expect(pin()).rejects.toMatchObject({
      memoryAnswerTaskErrorCode: "invalid_project_scope"
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("pins Global caller context and preserves explicit unknown context on retry", async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "koed-global-context-"))
  );
  try {
    execFileSync("git", ["init", "--initial-branch=main", directory]);
    execFileSync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "https://github.com/example/global.git"
    ]);
    const environment = { KOED_HOME: path.join(directory, "profile") };
    const pinned = await pinRepositoryRecallContext(
      { search_domain: "global" },
      { cwd: directory },
      environment
    );
    expect(pinned.repository_context).toMatchObject({
      kind: "portable_repository",
      branch: "main"
    });
    execFileSync("git", [
      "-C",
      directory,
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/changed.git"
    ]);
    execFileSync("git", [
      "-C",
      directory,
      "symbolic-ref",
      "HEAD",
      "refs/heads/changed"
    ]);
    expect(
      await pinRepositoryRecallContext(pinned, { cwd: "/missing" }, environment)
    ).toEqual(pinned);
    const unknown = await pinRepositoryRecallContext(
      { search_domain: "global" },
      { cwd: path.join(directory, "missing") },
      environment
    );
    expect(unknown.repository_context).toBeNull();
    expect(
      await pinRepositoryRecallContext(unknown, { cwd: directory }, environment)
    ).toEqual(unknown);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
