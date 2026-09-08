import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { withAuthenticatedGitRepository } from "./authenticated-git.js";

it("uses trusted transport configuration with access to the verified object store", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "koed-authenticated-git-test-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    await writeFile(resolve(root, "fixture.txt"), "Transport fixture\n");
    git(["add", "fixture.txt"]);
    git(["commit", "-m", "Fixture"]);
    const objectId = git(["rev-parse", "HEAD"]);
    await withAuthenticatedGitRepository(
      {
        credential: { scheme: "bearer", token: "fixture-only" },
        commonDirectory: resolve(root, ".git"),
        objectFormat: "sha1"
      },
      async (run) => {
        expect(await run(["show", `${objectId}:fixture.txt`])).toBe(
          "Transport fixture"
        );
        expect(await run(["config", "--get", "core.bare"])).toBe("true");
        expect(await run(["config", "--get", "http.followRedirects"])).toBe(
          "false"
        );
        expect(await run(["config", "--get", "credential.helper"])).toBe("");
        expect(await run(["config", "--get", "protocol.allow"])).toBe("never");
        expect(await run(["for-each-ref", "--format=%(refname)"])).toBe("");
        await run(["update-ref", "refs/heads/transport-fixture", objectId]);
        expect(await run(["rev-parse", "refs/heads/transport-fixture"])).toBe(
          objectId
        );
      }
    );
    expect(git(["for-each-ref", "--format=%(refname)"])).toBe(
      "refs/heads/main"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
