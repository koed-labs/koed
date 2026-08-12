import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateRunCapacity, SafeRunDirectory } from "./output-path.js";

describe("experience replay output safety", () => {
  it("estimates retained storage and concurrent duration", () => {
    expect(
      estimateRunCapacity({
        sourceAttempts: 2,
        replayAttempts: 8,
        maximumTrajectoryBytes: 100,
        estimatedAttemptArtifactBytes: 20,
        estimatedImageBytes: 50,
        scratchMultiplier: 2,
        reserveBytes: 1_000,
        attemptDurationSeconds: { minimum: 3, maximum: 9 },
        concurrency: 2
      })
    ).toEqual({
      requiredBytes: 900,
      reserveBytes: 1_000,
      estimatedDurationSeconds: { minimum: 15, maximum: 45 }
    });
  });

  it.each([
    ["maximumTrajectoryBytes", Number.NaN],
    ["estimatedAttemptArtifactBytes", Number.POSITIVE_INFINITY],
    ["estimatedImageBytes", -1],
    ["scratchMultiplier", Number.NaN],
    ["reserveBytes", -1],
    ["minimum duration", Number.NEGATIVE_INFINITY]
  ])("rejects invalid finite capacity input %s", (field, invalid) => {
    const input = {
      sourceAttempts: 1,
      replayAttempts: 1,
      maximumTrajectoryBytes: 1,
      estimatedAttemptArtifactBytes: 1,
      estimatedImageBytes: 1,
      scratchMultiplier: 1,
      reserveBytes: 1,
      attemptDurationSeconds: { minimum: 1, maximum: 2 },
      concurrency: 1
    };
    if (field === "minimum duration") {
      input.attemptDurationSeconds.minimum = invalid;
    } else {
      (input as Record<string, unknown>)[field] = invalid;
    }
    expect(() => estimateRunCapacity(input)).toThrow();
  });

  it("rejects repository descendants and symlinked output ancestors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-output-test-"));
    const repository = path.join(root, "repo");
    const external = path.join(root, "external");
    await mkdir(repository);
    await mkdir(external);
    await expect(
      SafeRunDirectory.create({
        outputPath: path.join(repository, "run"),
        repositoryRoot: repository,
        requiredBytes: 0,
        reserveBytes: 0
      })
    ).rejects.toThrow("outside the repository");
    const link = path.join(root, "linked");
    await symlink(external, link);
    await expect(
      SafeRunDirectory.create({
        outputPath: path.join(link, "run"),
        repositoryRoot: repository,
        requiredBytes: 0,
        reserveBytes: 0
      })
    ).rejects.toThrow("symlink");
    await expect(
      SafeRunDirectory.create({
        outputPath: `${external}${path.sep}..${path.sep}aliased-run`,
        repositoryRoot: repository,
        requiredBytes: 0,
        reserveBytes: 0
      })
    ).rejects.toThrow("dot path components");
  });

  it("writes restrictive artifacts and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-output-test-"));
    const repository = path.join(root, "repo");
    await mkdir(repository);
    const { directory } = await SafeRunDirectory.create({
      outputPath: path.join(root, "run"),
      repositoryRoot: repository,
      requiredBytes: 0,
      reserveBytes: 0
    });
    await directory.writeJson("report/summary.json", { ok: true });
    await expect(directory.writeJson("../escape.json", {})).rejects.toThrow(
      "dot path components"
    );
    await expect(
      directory.writeJson("report/summary.json", { replaced: true })
    ).rejects.toThrow();
    await expect(
      directory.writeJson("report/../escape.json", {})
    ).rejects.toThrow("dot path components");
  });

  it("rejects symlinked parents and journal leaves without changing targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-output-test-"));
    const repository = path.join(root, "repo");
    const external = path.join(root, "external");
    await mkdir(repository);
    await mkdir(external);
    const { directory } = await SafeRunDirectory.create({
      outputPath: path.join(root, "run"),
      repositoryRoot: repository,
      requiredBytes: 0,
      reserveBytes: 0
    });
    await symlink(external, path.join(directory.root, "alias"));
    await expect(directory.writeJson("alias/stolen.json", {})).rejects.toThrow(
      "symlink"
    );

    const target = path.join(external, "journal-target.jsonl");
    await writeFile(target, "original\n");
    await symlink(target, path.join(directory.root, "journal.jsonl"));
    await expect(
      directory.appendJsonLine("journal.jsonl", { bad: true })
    ).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("original\n");
  });

  it("detects replacement of the admitted run pathname", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-output-test-"));
    const repository = path.join(root, "repo");
    const external = path.join(root, "external");
    const run = path.join(root, "run");
    await mkdir(repository);
    await mkdir(external);
    const { directory } = await SafeRunDirectory.create({
      outputPath: run,
      repositoryRoot: repository,
      requiredBytes: 0,
      reserveBytes: 0
    });
    await rename(run, path.join(root, "displaced-run"));
    await symlink(external, run);
    await expect(directory.writeJson("stolen.json", {})).rejects.toThrow();
    await expect(
      readFile(path.join(external, "stolen.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
