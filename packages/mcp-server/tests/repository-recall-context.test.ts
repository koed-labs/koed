import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  discoverProjectMetadata,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { repositoryScopeId } from "@koed/shared";
import { pinRepositoryRecallContext } from "../src/repository-recall-context.js";

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
