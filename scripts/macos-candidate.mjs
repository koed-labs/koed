import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  mkdtempSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { candidateGithub } from "./candidate-github.mjs";
import { extractArtifactPayload } from "./candidate-artifact-container.mjs";
import {
  findRunArtifact,
  gatherCandidateObservation,
  validateCandidateTuple,
  validateDispatchContext,
  validateSigningEnvironment,
  validateTupleFormat
} from "./candidate-artifact-provenance.mjs";
import {
  readCandidateVersion,
  validateCandidateArchive,
  validateCandidateBundle
} from "./candidate-macos-payload.mjs";
import { signAndPackageCandidate } from "../apps/desktop/scripts/sign-candidate-macos.mjs";

const maxBytes = 3 * 1024 ** 3;
const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const positive = (key) => {
  const value = required(key);
  if (!/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Invalid ${key}`);
  return Number(value);
};
const context = () => {
  const value = {
    repository: required("GITHUB_REPOSITORY"),
    ref: required("GITHUB_REF"),
    workflowRef: required("GITHUB_WORKFLOW_REF"),
    sha: required("GITHUB_SHA"),
    runId: positive("GITHUB_RUN_ID"),
    runAttempt: positive("GITHUB_RUN_ATTEMPT"),
    pr: positive("CANDIDATE_PR"),
    candidateSha: required("CANDIDATE_SHA")
  };
  validateDispatchContext(value);
  return value;
};
const emit = (name, value) => {
  const text = String(value);
  if (!/^[a-z_]+$/.test(name) || /[\r\n]/.test(text))
    throw new Error("Invalid workflow output");
  appendFileSync(required("GITHUB_OUTPUT"), `${name}=${text}\n`);
};
const workspace = () => {
  const root = realpathSync.native(required("RUNNER_TEMP"));
  return mkdtempSync(join(root, "koed-candidate-"));
};
const assertPr = (pr, ctx) => {
  if (
    pr.number !== ctx.pr ||
    pr.state !== "open" ||
    pr.base?.ref !== "main" ||
    pr.head?.repo?.full_name !== ctx.repository ||
    pr.head?.sha !== ctx.candidateSha
  )
    throw new Error("Candidate PR does not match the requested head");
};
const prepare = async (ctx, api) => {
  await validateSigningEnvironment(api);
  const [main, pr] = await Promise.all([
    api("/repos/koed-labs/koed/git/ref/heads/main"),
    api(`/repos/koed-labs/koed/pulls/${ctx.pr}`)
  ]);
  if (main.object?.sha !== ctx.sha)
    throw new Error("Protected main moved or does not match workflow SHA");
  assertPr(pr, ctx);
  emit("sha", ctx.candidateSha);
  emit("pr", ctx.pr);
};
const selectArtifact = async (ctx, api, expectedId) => {
  const matches = await findRunArtifact(api, ctx.runId, ctx.runAttempt);
  if (
    matches.length !== 1 ||
    matches[0].expired !== false ||
    matches[0].workflow_run?.id !== ctx.runId ||
    !Number.isSafeInteger(matches[0].id) ||
    matches[0].id <= 0 ||
    (expectedId !== undefined && matches[0].id !== expectedId)
  )
    throw new Error("Unsigned artifact identity is missing or ambiguous");
  return matches[0].id;
};
const fetchPayload = async (ctx, client, root, expectedId, expectedDigest) => {
  const id = await selectArtifact(ctx, client.api, expectedId);
  const container = join(root, "artifact.zip");
  const payload = join(root, "unsigned.zip");
  await client.downloadArtifact(id, container, maxBytes);
  const { sha256 } = await extractArtifactPayload(container, payload, {
    maxBytes
  });
  if (expectedDigest !== undefined && sha256 !== expectedDigest)
    throw new Error("Approved artifact digest mismatch");
  const extracted = await validateCandidateArchive(payload, {
    sha256,
    maxBytes,
    maxEntries: 50000,
    workspace: root
  });
  const version = readCandidateVersion(extracted);
  const bundle = validateCandidateBundle(extracted, {
    expectedVersion: version
  });
  return { id, sha256, version, bundle };
};
const observation = async (tuple, ctx, payload, client) => {
  const observed = await gatherCandidateObservation(tuple, {
    api: client.api,
    workflowRef: ctx.ref,
    workflowSha: ctx.sha,
    artifactSha256: payload.sha256,
    expectedTeamId: required("DESKTOP_MACOS_APPLE_TEAM_ID"),
    version: payload.version
  });
  return validateCandidateTuple(tuple, observed);
};
const inspect = async (ctx, client) => {
  await validateSigningEnvironment(client.api);
  const payload = await fetchPayload(ctx, client, workspace());
  const tuple = {
    repository: ctx.repository,
    pr: ctx.pr,
    candidateSha: ctx.candidateSha,
    workflowSha: ctx.sha,
    runId: ctx.runId,
    runAttempt: ctx.runAttempt,
    artifactId: payload.id,
    artifactSha256: payload.sha256,
    expectedTeamId: required("DESKTOP_MACOS_APPLE_TEAM_ID"),
    version: payload.version
  };
  await observation(tuple, ctx, payload, client);
  emit("tuple", JSON.stringify(tuple));
  appendFileSync(
    required("GITHUB_STEP_SUMMARY"),
    `## Candidate awaiting approval\n\nReview this exact tuple and the source before approving the protected signing job.\n\n\`\`\`json\n${JSON.stringify(tuple, null, 2)}\n\`\`\`\n`
  );
};
const digestFile = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const approvedTuple = (ctx) => {
  const tuple = JSON.parse(required("CANDIDATE_TUPLE"));
  validateTupleFormat(tuple);
  if (
    tuple.repository !== ctx.repository ||
    tuple.pr !== ctx.pr ||
    tuple.candidateSha !== ctx.candidateSha ||
    tuple.workflowSha !== ctx.sha ||
    tuple.runId !== ctx.runId ||
    tuple.runAttempt !== ctx.runAttempt
  )
    throw new Error("Approved tuple does not match current workflow");
  return tuple;
};
const sign = async (ctx, client) => {
  await validateSigningEnvironment(client.api);
  const tuple = approvedTuple(ctx);
  const root = workspace();
  const payload = await fetchPayload(
    ctx,
    client,
    root,
    tuple.artifactId,
    tuple.artifactSha256
  );
  await observation(tuple, ctx, payload, client);
  const outputDir = join(root, "signed-output");
  const outputs = await signAndPackageCandidate({
    bundle: payload.bundle,
    outputDir,
    workspace: root,
    expectedTeamId: tuple.expectedTeamId,
    p12Base64: required("CANDIDATE_P12_BASE64"),
    p12Password: required("CANDIDATE_P12_PASSWORD"),
    apiKeyBase64: required("CANDIDATE_APPLE_API_KEY_P8_BASE64"),
    apiKeyId: required("CANDIDATE_APPLE_API_KEY_ID"),
    issuerId: required("CANDIDATE_APPLE_API_ISSUER")
  });
  emit("path", outputDir);
  emit("zip_sha", await digestFile(outputs.zip));
  emit("dmg_sha", await digestFile(outputs.dmg));
};
const verifyHashes = async () => {
  const folder = realpathSync.native(required("CANDIDATE_OUTPUT_DIR"));
  for (const [file, expected] of [
    ["Koed.zip", required("CANDIDATE_ZIP_SHA")],
    ["Koed.dmg", required("CANDIDATE_DMG_SHA")]
  ]) {
    if (
      !/^[0-9a-f]{64}$/.test(expected) ||
      (await digestFile(join(folder, file))) !== expected
    )
      throw new Error("Signed artifact digest mismatch");
  }
};
const writeProvenance = async () => {
  await verifyHashes();
  const tuple = JSON.parse(required("CANDIDATE_TUPLE"));
  validateTupleFormat(tuple);
  const data = {
    tuple,
    zipSha256: required("CANDIDATE_ZIP_SHA"),
    dmgSha256: required("CANDIDATE_DMG_SHA"),
    note: "Candidate-reported CLI and Desktop smoke is not proof of candidate safety or service health."
  };
  writeFileSync(
    join(
      realpathSync.native(required("CANDIDATE_OUTPUT_DIR")),
      "provenance.json"
    ),
    `${JSON.stringify(data, null, 2)}\n`,
    { mode: 0o600, flag: "wx" }
  );
};
const main = async () => {
  const command = process.argv[2];
  if (command === "verify-hashes") return verifyHashes();
  if (command === "write-provenance") return writeProvenance();
  const ctx = context();
  const client = candidateGithub(required("GH_TOKEN"));
  if (command === "prepare") return prepare(ctx, client.api);
  if (command === "inspect") return inspect(ctx, client);
  if (command === "sign") return sign(ctx, client);
  throw new Error("Invalid candidate workflow command");
};
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Candidate workflow failed"
  );
  process.exitCode = 1;
});
