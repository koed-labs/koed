import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { attestExactModels, attestExecutable } from "./toolchain.js";

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
});
