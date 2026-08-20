import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readJsonArtifact,
  validateExistingRunDirectory,
  writeTextArtifactAtomic
} from "./artifacts.js";

describe("experience replay artifact safety", () => {
  it("rejects original-path symlink aliases for run admission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-artifact-test-"));
    const repository = path.join(root, "repo");
    const run = path.join(root, "run");
    await mkdir(repository);
    await mkdir(run);
    const alias = path.join(root, "run-alias");
    await symlink(run, alias);
    await expect(
      validateExistingRunDirectory(alias, repository)
    ).rejects.toThrow("symlink");
  });

  it("does not follow artifact leaf or parent symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-artifact-test-"));
    const run = path.join(root, "run");
    const external = path.join(root, "external");
    await mkdir(run);
    await mkdir(external);
    const secret = path.join(external, "secret.json");
    await writeFile(secret, '{"secret":true}\n');
    await symlink(secret, path.join(run, "leaf.json"));
    await symlink(external, path.join(run, "parent"));
    await expect(readJsonArtifact(run, "leaf.json")).rejects.toThrow("symlink");
    await expect(readJsonArtifact(run, "parent/secret.json")).rejects.toThrow(
      "symlink"
    );
  });

  it("publishes atomically without overwriting an existing artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-artifact-test-"));
    const run = path.join(root, "run");
    await mkdir(run);
    await writeTextArtifactAtomic(run, "report.json", "first\n");
    await expect(
      writeTextArtifactAtomic(run, "report.json", "second\n")
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(run, "report.json"), "utf8")).toBe(
      "first\n"
    );
  });

  it("rejects dot aliases and bounded-path violations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-artifact-test-"));
    const run = path.join(root, "run");
    await mkdir(run);
    await expect(readJsonArtifact(run, "nested/../value.json")).rejects.toThrow(
      "dot path components"
    );
    await expect(
      writeTextArtifactAtomic(run, `${"x".repeat(256)}/value.json`, "x")
    ).rejects.toThrow("overlong component");
  });
});
