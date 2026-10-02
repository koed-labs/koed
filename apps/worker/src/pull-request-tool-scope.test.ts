import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pullRequestReadToolAllowed } from "./pull-request-tool-scope.js";
it("allows checkout inspection but rejects outside files, symlinks, and escaping glob patterns", async () => {
  const home = await mkdtemp(join(tmpdir(), "koed-pr-tools-"));
  const checkout = join(home, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, "code.ts"), "export {};");
  await writeFile(join(home, "secret"), "fixture");
  await symlink(join(home, "secret"), join(checkout, "link"));
  try {
    expect(
      await pullRequestReadToolAllowed(checkout, "Read", {
        file_path: "code.ts"
      })
    ).toBe(true);
    expect(
      await pullRequestReadToolAllowed(checkout, "Grep", {
        pattern: "../ is a string",
        path: checkout
      })
    ).toBe(true);
    expect(
      await pullRequestReadToolAllowed(checkout, "Glob", { pattern: "**/*.ts" })
    ).toBe(true);
    for (const input of [
      { file_path: "../secret" },
      { file_path: join(home, "secret") },
      { file_path: "link" },
      { file_path: "~/.ssh/id_rsa" },
      { file_path: "missing" }
    ]) {
      expect(await pullRequestReadToolAllowed(checkout, "Read", input)).toBe(
        false
      );
    }
    expect(
      await pullRequestReadToolAllowed(checkout, "Glob", { pattern: "../../*" })
    ).toBe(false);
    expect(
      await pullRequestReadToolAllowed(checkout, "Bash", {
        command: "cat ../secret"
      })
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
