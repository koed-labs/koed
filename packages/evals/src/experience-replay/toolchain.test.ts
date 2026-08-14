import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  attestExactModels,
  attestExecutable,
  executeBoundedCommand
} from "./toolchain.js";

describe("toolchain attestations", () => {
  it("hashes and versions a real executable", async () => {
    const expectedSha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    await expect(
      attestExecutable({
        binary: process.execPath,
        versionArguments: ["--version"],
        expectedSha256,
        expectedVersion: process.version
      })
    ).resolves.toMatchObject({ sha256: expectedSha256 });
    await expect(
      attestExecutable({
        binary: process.execPath,
        versionArguments: ["--version"],
        expectedSha256: "0".repeat(64),
        expectedVersion: process.version
      })
    ).rejects.toThrow("digest mismatch");
  });

  it("requires exact model/list identities under the supplied auth context", async () => {
    const listModels = vi.fn(async () => [
      {
        id: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        label: "Luna",
        description: "Pinned test model",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: []
      }
    ]);
    await expect(
      attestExactModels({
        binary: "/pinned/codex",
        requiredModelIds: ["gpt-5.6-luna"],
        environment: {},
        cwd: "/tmp",
        listModels
      })
    ).resolves.toHaveLength(1);
    expect(listModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
      30_000
    );
    await expect(
      attestExactModels({
        binary: "/pinned/codex",
        requiredModelIds: ["gpt-5.6-sol"],
        environment: {},
        cwd: "/tmp",
        listModels
      })
    ).rejects.toThrow("exact model gpt-5.6-sol");
  });

  it("rejects version substring matches, malformed hashes, and duplicate model IDs", async () => {
    const expectedSha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    await expect(
      attestExecutable({
        binary: process.execPath,
        versionArguments: ["--version"],
        expectedSha256,
        expectedVersion: process.version.slice(0, -1)
      })
    ).rejects.toThrow("expected exact version");
    await expect(
      attestExecutable({
        binary: process.execPath,
        versionArguments: ["--version"],
        expectedSha256: "A".repeat(64),
        expectedVersion: process.version
      })
    ).rejects.toThrow("Invalid expected");

    const duplicate = vi.fn(async () => [
      { id: "exact", model: "exact" },
      { id: "exact", model: "fallback" }
    ]);
    await expect(
      attestExactModels({
        binary: "/codex",
        requiredModelIds: ["exact"],
        environment: {},
        cwd: "/tmp",
        listModels: duplicate as never
      })
    ).rejects.toThrow("duplicate model ID");
  });

  it("executes arguments without a shell and enforces output bounds", async () => {
    const marker = `codex-shell-attack-${process.pid}`;
    await expect(
      executeBoundedCommand({
        file: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.argv[1])",
          `; touch /tmp/${marker}`
        ]
      })
    ).resolves.toEqual({ stdout: `; touch /tmp/${marker}`, stderr: "" });
    await expect(
      executeBoundedCommand({
        file: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(100))"],
        maxOutputBytes: 10
      })
    ).rejects.toThrow("output limit");
  });
});
