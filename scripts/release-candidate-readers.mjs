import { readFileSync } from "node:fs";
import {
  validateReviewedBuildIdentity,
  sha256,
  verifyReleaseCandidate
} from "./release-candidate-verification.mjs";

export const candidateAssetTransferTimeoutMs = 20 * 60 * 1000;

const readBytes = async (response, limit) => {
  if (!response.ok)
    throw new Error(`Candidate reader returned HTTP ${response.status}.`);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit)
      throw new Error("Candidate reader response exceeds size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

// Deliberately GET-only: no shell runner, OIDC, signing or write methods.
export const createCandidateReaders = ({
  token = process.env.GH_TOKEN,
  fetchImpl = fetch
} = {}) => {
  const github = async (path, binary = false) => {
    const response = await fetchImpl(`https://api.github.com/repos/${path}`, {
      method: "GET",
      headers: {
        accept: binary
          ? "application/octet-stream"
          : "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      signal: AbortSignal.timeout(
        binary ? candidateAssetTransferTimeoutMs : 120000
      )
    });
    if (binary) {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Candidate reader returned HTTP ${response.status}.`);
      }
      if (!response.body)
        throw new Error("Candidate reader response has no body.");
      return response.body;
    }
    const bytes = await readBytes(response, 16 * 1024 ** 2);
    return JSON.parse(bytes.toString("utf8"));
  };
  const repo = (value) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(value))
      throw new Error("Invalid repository identity.");
    return value;
  };
  const id = (value) => {
    if (!/^[1-9]\d*$/.test(String(value)))
      throw new Error("Invalid GitHub object identity.");
    return value;
  };
  return Object.freeze({
    getWorkflowRun: (repository, runId) =>
      github(`${repo(repository)}/actions/runs/${id(runId)}`),
    getArtifact: (repository, artifactId) =>
      github(`${repo(repository)}/actions/artifacts/${id(artifactId)}`),
    getRelease: (repository, releaseId) =>
      github(`${repo(repository)}/releases/${id(releaseId)}`),
    getAsset: (repository, assetId) =>
      github(`${repo(repository)}/releases/assets/${id(assetId)}`, true),
    getRegistryVersion: async (name, version) => {
      if (
        name !== "@koed-labs/server" ||
        !/^(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(version)
      )
        throw new Error("Invalid registry identity.");
      const response = await fetchImpl(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
        { method: "GET", signal: AbortSignal.timeout(30000) }
      );
      if (response.status === 404) return null;
      return JSON.parse(
        (await readBytes(response, 16 * 1024 ** 2)).toString("utf8")
      );
    }
  });
};

export const runReleaseVerification = async (
  args,
  readers = createCandidateReaders()
) => {
  const bytes = readFileSync(args.expectedBuild);
  if (
    !/^[a-f0-9]{64}$/.test(args.expectedBuildSha256 ?? "") ||
    sha256(bytes) !== args.expectedBuildSha256
  )
    throw new Error("Protected expected-build digest mismatch.");
  const expected = validateReviewedBuildIdentity(
    JSON.parse(bytes.toString("utf8"))
  );
  const identity = await readers.getArtifact(
    args.repository,
    Number(args.identityArtifactId)
  );
  if (
    !/^sha256:[a-f0-9]{64}$/.test(args.identityArtifactDigest ?? "") ||
    identity.id !== Number(args.identityArtifactId) ||
    identity.name !== "koed-reviewed-release-identity" ||
    identity.digest !== args.identityArtifactDigest ||
    identity.expired !== false ||
    identity.workflow_run?.id !== Number(args.approvedRunId) ||
    identity.workflow_run?.head_sha !== args.reviewedCommit
  )
    throw new Error(
      "Protected identity artifact mismatch or expired artifact."
    );
  return verifyReleaseCandidate(
    {
      repository: args.repository,
      commit: args.reviewedCommit,
      runId: Number(args.approvedRunId),
      runAttempt: Number(args.approvedRunAttempt),
      version: args.version,
      releaseId: args.releaseId,
      expected
    },
    readers
  );
};
