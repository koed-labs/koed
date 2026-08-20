import { describe, expect, it, vi } from "vitest";
import {
  assertImmutableImageReference,
  freezeTaskImages,
  inspectImmutableOciImage,
  verifyFrozenTaskImage,
  type TaskImageBuildResult
} from "./image-attestation.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const built = (): TaskImageBuildResult => ({
  immutableReference: `registry.example/task@${digest("b")}`,
  imageId: digest("c"),
  contentDigest: digest("b"),
  resolvedBaseImageDigests: [digest("d")],
  dockerfileSha256: digest("e"),
  dockerVersion: "Docker version 29.0.0",
  buildkitVersion: "buildkit v0.24.0",
  provenanceSha256: digest("f")
});

describe("recorded task image attestations", () => {
  it("builds each selected task once and freezes immutable identities", async () => {
    const build = vi.fn(async () => built());
    const [frozen] = await freezeTaskImages(
      [{ taskName: "task-a", taskDigest: digest("a") }],
      build
    );
    expect(build).toHaveBeenCalledOnce();
    expect(frozen?.attestationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyFrozenTaskImage(frozen!, built())).not.toThrow();
  });

  it.each([
    "ubuntu:latest",
    "ubuntu:24.04",
    "ubuntu@sha256:xyz",
    "ubuntu@sha256:" + "A".repeat(64),
    "ubuntu@sha256:" + "a".repeat(64) + " extra"
  ])("rejects mutable or malformed image reference %s", (reference) => {
    expect(() => assertImmutableImageReference(reference)).toThrow(
      "Mutable or malformed"
    );
  });

  it("rejects digest substitution, malformed provenance fields, and post-freeze drift", async () => {
    await expect(
      freezeTaskImages(
        [{ taskName: "task-a", taskDigest: digest("a") }],
        async () => ({ ...built(), contentDigest: digest("f") })
      )
    ).rejects.toThrow("reference/content digest mismatch");
    await expect(
      freezeTaskImages(
        [{ taskName: "task-a", taskDigest: digest("a") }],
        async () => ({ ...built(), dockerVersion: "Docker\nforged" })
      )
    ).rejects.toThrow("one non-empty");
    await expect(
      freezeTaskImages(
        [{ taskName: "task-a", taskDigest: digest("a") }],
        async () => ({ ...built(), provenanceSha256: "unbounded-object" })
      )
    ).rejects.toThrow("Build provenance hash");
    const [frozen] = await freezeTaskImages(
      [{ taskName: "task-a", taskDigest: digest("a") }],
      async () => built()
    );
    expect(() =>
      verifyFrozenTaskImage(frozen!, {
        ...built(),
        imageId: digest("f")
      })
    ).toThrow("changed");
  });

  it("inspects the exact digest with bounded shell-free argv", async () => {
    const reference = `registry.example/task@${digest("b")}`;
    let invocation = 0;
    const executor = vi.fn(async (command) => {
      invocation += 1;
      expect(command).toMatchObject(
        invocation === 1
          ? {
              file: "docker-safe",
              args: ["pull", reference],
              timeoutMs: 30 * 60_000,
              maxOutputBytes: 1024 * 1024
            }
          : {
              file: "docker-safe",
              args: ["image", "inspect", reference, "--format", "{{json .}}"],
              timeoutMs: 30_000,
              maxOutputBytes: 1024 * 1024
            }
      );
      return {
        stdout:
          invocation === 1
            ? ""
            : JSON.stringify({ Id: digest("c"), RepoDigests: [reference] }),
        stderr: ""
      };
    });
    await expect(
      inspectImmutableOciImage({
        immutableReference: reference,
        dockerExecutable: "docker-safe",
        executor
      })
    ).resolves.toEqual({
      immutableReference: reference,
      imageId: digest("c"),
      contentDigest: digest("b")
    });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed or mismatched Docker inspection output", async () => {
    const reference = `registry.example/task@${digest("b")}`;
    await expect(
      inspectImmutableOciImage({
        immutableReference: reference,
        executor: async () => ({ stdout: "{}\n{}", stderr: "" })
      })
    ).rejects.toThrow("malformed JSON");
    await expect(
      inspectImmutableOciImage({
        immutableReference: reference,
        executor: async () => ({
          stdout: JSON.stringify({
            Id: digest("c"),
            RepoDigests: [`registry.example/other@${digest("b")}`]
          }),
          stderr: ""
        })
      })
    ).rejects.toThrow("exact immutable reference");
  });
});
