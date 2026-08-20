import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeSanitizedAtifTrajectory,
  type AtifSanitizationManifest,
  type SanitizedAtifTrajectory
} from "./atif/index.js";
import { canonicalJson } from "./core/hash.js";
import {
  loadOracleCorpusArtifact,
  persistOracleCorpusArtifact,
  type OracleCorpusArtifactEntry,
  type OracleCorpusArtifactIdentity
} from "./oracle-corpus-artifact.js";
import {
  buildOracleCorpus,
  type SuccessfulOracleSource
} from "./oracle-corpus.js";

const temporaryRoots: string[] = [];
const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: string): string => `sha256:${sha256(value)}`;
const brief = "Sanitized verifier oracle: preserve the exact parser boundary.";

const identity: OracleCorpusArtifactIdentity = {
  model: "gpt-test",
  reasoningEffort: "high",
  task: { name: "parser-task", digest: digest("task") },
  codex: { version: "1.2.3" },
  taskImage: {
    taskName: "parser-task",
    taskDigest: digest("task"),
    immutableReference: `registry.example/parser@${digest("image")}`,
    imageId: digest("image"),
    contentDigest: digest("image"),
    resolvedBaseImageDigests: [digest("base-image")],
    dockerfileSha256: digest("dockerfile"),
    dockerVersion: "Docker test",
    buildkitVersion: "BuildKit test",
    provenanceSha256: digest("provenance"),
    attestationHash: sha256("image-attestation")
  },
  sanitizer: { name: "atif-sanitizer", version: "1.0.0" }
};

const source = (): SuccessfulOracleSource => {
  const trajectory: SanitizedAtifTrajectory = {
    schema_version: "ATIF-v1.7",
    agent: { name: "codex", version: identity.codex.version },
    steps: [
      { step_id: 1, source: "system", message: brief },
      { step_id: 2, source: "user", message: "Fix the parser." },
      { step_id: 3, source: "agent", message: "Applied the boundary fix." }
    ]
  };
  const manifest: AtifSanitizationManifest = {
    inputSha256: sha256("raw-private-source"),
    outputSha256: null,
    schemaVersion: "ATIF-v1.7",
    allowedFieldCounts: {},
    removedFieldCounts: {},
    redactionCounts: {},
    limitUsage: {
      rawBytes: 100,
      nestingDepth: 4,
      steps: 3,
      nestedValues: 12,
      largestStringBytes: 64,
      allowedTextBytes: 100,
      allowedTextTokens: 20
    },
    cutoffAttested: true,
    rejectionReason: null
  };
  return {
    taskDigest: identity.task.digest,
    sourceAttemptId: "source-1",
    passed: true,
    reward: 1,
    expectedSuccessValue: 1,
    failureCategory: null,
    sanitization: materializeSanitizedAtifTrajectory(trajectory, {
      taskDigest: identity.task.digest,
      sourceAttemptId: "source-1",
      sourceManifest: manifest
    })
  };
};

const corpusInput = () => {
  const successfulSource = source();
  return {
    identity,
    oracleBrief: brief,
    source: successfulSource,
    corpus: buildOracleCorpus({
      oracleBrief: brief,
      oracleBriefSha256: sha256(brief),
      source: successfulSource
    })
  };
};

const location = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "koed-oracle-corpus-test-"));
  temporaryRoots.push(root);
  const repositoryRoot = path.join(root, "repository");
  await mkdir(repositoryRoot, { mode: 0o700 });
  return {
    corpusDirectory: path.join(root, "private-corpus", "parser-task"),
    repositoryRoot
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("private oracle corpus artifact", () => {
  it("atomically persists and loads one fully attested sanitized corpus", async () => {
    const target = await location();
    const written = await persistOracleCorpusArtifact(target, corpusInput());
    const loaded = await loadOracleCorpusArtifact(target, identity);

    expect(loaded).toEqual(written);
    expect(loaded.classification).toBe("private-benchmark-corpus");
    expect(loaded.attestationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await lstat(target.corpusDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (
        await lstat(
          path.join(target.corpusDirectory, "oracle-corpus-artifact.json")
        )
      ).mode & 0o777
    ).toBe(0o600);
    expect(
      (
        await readFile(
          path.join(target.corpusDirectory, "oracle-corpus-artifact.json"),
          "utf8"
        )
      ).includes(brief)
    ).toBe(true);
  });

  it("is immutable and refuses to replace the private corpus", async () => {
    const target = await location();
    await persistOracleCorpusArtifact(target, corpusInput());
    await expect(
      persistOracleCorpusArtifact(target, corpusInput())
    ).rejects.toMatchObject({
      code: "EEXIST"
    });
  });

  it("rejects relative, in-repository, and symlinked directories", async () => {
    await expect(
      persistOracleCorpusArtifact(
        { corpusDirectory: "relative-corpus", repositoryRoot: process.cwd() },
        corpusInput()
      )
    ).rejects.toThrow("must be absolute");
    await expect(
      persistOracleCorpusArtifact(
        {
          corpusDirectory: path.join(process.cwd(), ".private-oracle-corpus"),
          repositoryRoot: process.cwd()
        },
        corpusInput()
      )
    ).rejects.toThrow("outside the repository");

    const target = await location();
    const realDirectory = `${target.corpusDirectory}-real`;
    await persistOracleCorpusArtifact(
      { ...target, corpusDirectory: realDirectory },
      corpusInput()
    );
    await symlink(realDirectory, target.corpusDirectory, "dir");
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow(
      "symlink"
    );
  });

  it("fails closed on permissions, leaf symlinks, and identity mismatch", async () => {
    const target = await location();
    await persistOracleCorpusArtifact(target, corpusInput());
    const artifactPath = path.join(
      target.corpusDirectory,
      "oracle-corpus-artifact.json"
    );
    await chmod(artifactPath, 0o644);
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow(
      "0600"
    );
    await chmod(artifactPath, 0o600);
    await expect(
      loadOracleCorpusArtifact(target, {
        ...identity,
        model: "different-model"
      })
    ).rejects.toThrow("identity mismatch");

    const copy = path.join(path.dirname(target.corpusDirectory), "copy.json");
    await writeFile(copy, await readFile(artifactPath), { mode: 0o600 });
    await unlink(artifactPath);
    await symlink(copy, artifactPath);
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow();
  });

  it("rejects corruption, unknown fields, and re-attested provenance tampering", async () => {
    const target = await location();
    await persistOracleCorpusArtifact(target, corpusInput());
    const artifactPath = path.join(
      target.corpusDirectory,
      "oracle-corpus-artifact.json"
    );

    await writeFile(artifactPath, "{bad json");
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow(
      "corrupt"
    );

    await rm(target.corpusDirectory, { recursive: true });
    await persistOracleCorpusArtifact(target, corpusInput());
    const unknown = JSON.parse(await readFile(artifactPath, "utf8")) as Record<
      string,
      unknown
    >;
    unknown.unexpected = true;
    const { attestationSha256: ignored, ...unknownBody } = unknown;
    void ignored;
    unknown.attestationSha256 = sha256(canonicalJson(unknownBody));
    await writeFile(artifactPath, canonicalJson(unknown));
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow();

    await rm(target.corpusDirectory, { recursive: true });
    await persistOracleCorpusArtifact(target, corpusInput());
    const tampered = JSON.parse(
      await readFile(artifactPath, "utf8")
    ) as OracleCorpusArtifactEntry;
    tampered.corpus.fullExperience.sha256 = sha256("forged-artifact");
    tampered.corpus.provenance.artifacts["full-experience"] =
      tampered.corpus.fullExperience.sha256;
    const { attestationSha256: oldAttestation, ...tamperedBody } = tampered;
    void oldAttestation;
    tampered.attestationSha256 = sha256(canonicalJson(tamperedBody));
    await writeFile(artifactPath, canonicalJson(tampered));
    await expect(loadOracleCorpusArtifact(target, identity)).rejects.toThrow(
      "artifact provenance mismatch"
    );
  });
});
