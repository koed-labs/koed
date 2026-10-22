import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDeviceBoundSourceSigner } from "@koed/shared";
import type { Hq713Actor } from "./hq713-fixture.js";

const teamOperationFamilies = [
  "action_grant",
  "team_workspace_read",
  "team_workspace_write",
  "team_chat_read",
  "team_chat_write",
  "share_grant_management",
  "sync",
  "managed_execution",
  "memory_answer_execution"
] as const;

/** Enroll the verified Personal source through the listening Team API. */
export const enrollHq713TeamSource = async (input: {
  actor: Hq713Actor;
  seed: {
    deviceId: string;
    deviceKeyId: string;
    deviceSecret: string;
    teamUserId: string;
  };
  teamBackendId: string;
}): Promise<string> => {
  const { actor, seed, teamBackendId } = input;
  const signer = createDeviceBoundSourceSigner({
    koedHome: actor.koedHome,
    sourceGenerationId: actor.deploymentId,
    originKeyId: actor.id,
    environment: {
      ...process.env,
      NODE_ENV: "test",
      KOED_DEVICE_PROOF_DIR: join(`${actor.koedHome}-proof-root`, "proof")
    }
  });
  assert.equal(signer.deploymentId, actor.deploymentId);
  assert.equal(signer.deviceInstanceId, seed.deviceId);
  const fingerprint = createHash("sha256")
    .update(Buffer.from(signer.publicKey, "base64url"))
    .digest("hex");
  const challengeHash = randomBytes(32).toString("hex");
  const requestedOperationFamilies = [...teamOperationFamilies];
  const response = await fetch(
    new URL("/v1/local-edge/device-enrollments/challenges", actor.team.baseUrl),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challenge_hash: challengeHash,
        upstream_backend_id: teamBackendId,
        device_instance_id: seed.deviceId,
        protocol_deployment_id: actor.deploymentId,
        source_owner_principal_id: actor.id,
        device_label: "Koed HQ-713 Personal source",
        requested_operation_families: requestedOperationFamilies,
        pending_credential: {
          credential_key_id: seed.deviceKeyId,
          verifier_kind: "secret_hash",
          verifier_secret: seed.deviceSecret,
          operation_families: requestedOperationFamilies
        },
        metadata: {
          source: "koed-server-upstream-enroll",
          curatedSourceAttestationKeyId: signer.keyId,
          curatedSourceAttestationPublicKey: signer.publicKey,
          curatedSourceAttestationFingerprint: fingerprint
        }
      })
    }
  );
  const created = (await response.json()) as {
    challenge?: { id?: string; status?: string };
    error?: string;
  };
  assert.equal(
    response.status,
    200,
    created.error ?? "Team enrollment challenge"
  );
  const challengeId = created.challenge?.id;
  assert.ok(challengeId, "Production Team challenge must return an ID");
  assert.equal(created.challenge?.status, "pending");

  const review = await actor.teamBrowser.request<{
    challenge: {
      id: string;
      status: string;
      requestedOperationFamilies: string[];
      metadata: Record<string, unknown>;
    };
  }>(
    "GET",
    `/v1/local-edge/device-enrollments/challenges/${encodeURIComponent(challengeId)}`,
    { expectedStatus: 200 }
  );
  assert.equal(review.body.challenge.id, challengeId);
  assert.equal(review.body.challenge.status, "pending");
  assert.deepEqual(
    review.body.challenge.requestedOperationFamilies,
    requestedOperationFamilies
  );
  assert.equal(
    review.body.challenge.metadata.curatedSourceAttestationFingerprint,
    fingerprint,
    "Browser review must display the Personal source fingerprint"
  );
  assert.equal(
    typeof review.body.challenge.metadata.highLevelContext,
    "string"
  );
  assert.ok(
    String(review.body.challenge.metadata.highLevelContext).includes(
      fingerprint
    ),
    "Existing browser review must show the server-derived source fingerprint"
  );
  assert.equal(
    review.body.challenge.metadata.curatedSourceAttestationKeyId,
    signer.keyId
  );
  assert.equal(
    review.body.challenge.metadata.curatedSourceAttestationPublicKey,
    signer.publicKey
  );

  const decision = await actor.teamBrowser.request<{
    challenge: { status: string };
    credential: {
      id: string;
      ownerUserId: string;
      credentialKeyId: string;
      upstreamBackendId: string;
      deviceInstanceId: string;
      operationFamilies: string[];
      metadata: Record<string, unknown>;
    };
  }>(
    "POST",
    `/v1/local-edge/device-enrollments/challenges/${encodeURIComponent(challengeId)}/approval`,
    { body: { decision: "approve" }, expectedStatus: 200 }
  );
  assert.equal(decision.body.challenge.status, "approved");
  const credential = decision.body.credential;
  assert.ok(credential?.id, "Browser approval must enroll the device");
  assert.equal(credential.ownerUserId, seed.teamUserId);
  assert.equal(credential.credentialKeyId, seed.deviceKeyId);
  assert.equal(credential.upstreamBackendId, teamBackendId);
  assert.equal(credential.deviceInstanceId, seed.deviceId);
  assert.deepEqual(credential.operationFamilies, requestedOperationFamilies);
  assert.equal(credential.metadata.protocolDeploymentId, actor.deploymentId);
  assert.equal(credential.metadata.sourceOwnerPrincipalId, actor.id);
  assert.equal(
    credential.metadata.curatedSourceAttestationFingerprint,
    fingerprint
  );
  return credential.id;
};
