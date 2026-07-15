import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import { pdsSessionPackageDigest } from "@koed/shared";
import { pdsConversationItemsForClosure } from "./local-source.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  pdsPublicKeyCommitment,
  pdsFinalizedStatementHash,
  signPdsGroupFinal,
  signPdsRecord,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsKeyBundle,
  validatePdsKeyBundleAck,
  verifyPdsEnrollmentProof,
  type PdsGroupStatement
} from "@koed/shared";
import type { PersonalDeviceGroupRecord } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  pdsCertificateParamsSchema,
  pdsChallengeSchema,
  pdsGenesisSchema,
  pdsEpochAckSchema,
  pdsGroupParamsSchema,
  pdsKeyBundleParamsSchema,
  pdsCloseSessionParamsSchema,
  pdsPauseSchema,
  pdsPolicySchema,
  pdsRemoteAccountLinkSchema,
  pdsTransitionSchema
} from "./schemas.js";

export interface PdsAuthoritySigner {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

export interface PdsRemoteAccountLinkVerifier {
  resolveRemoteAccountProof(proofToken: string): Promise<{
    issuer: string;
    deploymentId: string;
    subjectId: string;
    expiresAt: Date;
    nonce: string;
  }>;
}

const unavailable = (): never => {
  throw Object.assign(
    new Error("Personal Device Sync authority is unavailable"),
    { statusCode: 503 }
  );
};

const pdsAuthority = (context: ApiRouteContext): PdsAuthoritySigner =>
  context.personalDeviceSync.authoritySigner ?? unavailable();
const pdsError = (message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), { statusCode });
const browserDeploymentId = (context: ApiRouteContext): string => {
  const deploymentId = context.deploymentIdentity.inspect().deploymentId;
  if (!deploymentId)
    throw pdsError("PDS browser deployment identity is unavailable", 503);
  return deploymentId;
};
const parsedStatement = (input: string): PdsGroupStatement =>
  parseCanonicalPdsJson(input) as PdsGroupStatement;
const body = (statement: PdsGroupStatement): Record<string, unknown> =>
  statement.draft.body as Record<string, unknown>;
const draft = (statement: PdsGroupStatement): Record<string, unknown> =>
  statement.draft;
const string = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw pdsError(`PDS ${field} is invalid`);
  return value;
};

const publicGroup = (group: PersonalDeviceGroupRecord) => ({
  group_id: group.groupId,
  authority_key_id: group.authorityKeyId,
  authority_public_key: group.authorityPublicKey,
  current_epoch: group.currentEpoch,
  pending_epoch: group.pendingEpoch,
  pending_statement_sequence: group.pendingStatementSequence,
  pending_bundle_hash: group.pendingBundleHash,
  head: { sequence: group.headSequence, hash: group.headHash },
  state: group.state,
  ...(group.stateReason ? { state_reason: group.stateReason } : {}),
  members: group.members.map((member) => ({
    device_id: member.deviceId,
    signing_key_id: member.signingKeyId,
    signing_public_key: member.signingPublicKey,
    kem_key_id: member.kemKeyId,
    kem_public_key: member.kemPublicKey,
    operation_families: member.operationFamilies,
    status: member.status,
    admitted_sequence: member.admittedSequence,
    revoked_sequence: member.revokedSequence,
    revoked_at: member.revokedAt
  })),
  policy: {
    enabled: group.policy.enabled,
    future_closed_sessions_only: true,
    historical_backfill_enabled: false
  }
});

const authorizationPublicKey = (
  group: PersonalDeviceGroupRecord,
  statement: PdsGroupStatement
): string => {
  const keyId = string(
    statement.authorization?.signerKeyId,
    "authorization signer"
  );
  if (keyId === group.recoverySigningKeyId)
    return group.recoverySigningPublicKey;
  const member = group.members.find(
    (item) => item.signingKeyId === keyId && item.status === "active"
  );
  if (!member) throw pdsError("PDS authorization signer is not active", 403);
  return member.signingPublicKey;
};

const counterSignStatement = (
  statement: PdsGroupStatement,
  signer: PdsAuthoritySigner
): PdsGroupStatement => ({
  draft: draft(statement),
  authorization: statement.authorization,
  authority: {
    keyId: signer.keyId,
    signature: signPdsGroupFinal(
      { draft: draft(statement), authorization: statement.authorization },
      signer.privateKey
    )
  }
});

const deviceFromBody = (
  transition: "add-device" | "recover",
  statementBody: Record<string, unknown>
) => {
  void transition;
  return {
    deviceId: string(statementBody.deviceId, "deviceId"),
    signingKeyId: string(
      statementBody.deviceSigningKeyId,
      "deviceSigningKeyId"
    ),
    signingPublicKey: string(
      statementBody.deviceSigningPublicKey,
      "deviceSigningPublicKey"
    ),
    kemKeyId: string(statementBody.deviceKemKeyId, "deviceKemKeyId"),
    kemPublicKey: string(
      statementBody.deviceKemPublicKey,
      "deviceKemPublicKey"
    ),
    operationFamilies: ["pds_relay"]
  };
};

const enrollmentProof = (
  proof: {
    challenge_id: string;
    challenge: string;
    device_id: string;
    signature: string;
    expires_at: string;
  },
  groupId: string | undefined,
  device: {
    deviceId: string;
    signingKeyId: string;
    signingPublicKey: string;
    kemKeyId: string;
    kemPublicKey: string;
  },
  browserSubjectId: string,
  browserDeploymentId: string
) => ({
  challengeId: proof.challenge_id,
  challenge: proof.challenge,
  deviceId: proof.device_id,
  deviceSigningKeyId: device.signingKeyId,
  deviceSigningPublicKey: device.signingPublicKey,
  deviceKemKeyId: device.kemKeyId,
  deviceKemPublicKey: device.kemPublicKey,
  browserSubjectId,
  browserDeploymentId,
  expiresAt: proof.expires_at,
  signature: proof.signature,
  groupId
});

const issueMembershipCertificates = async (
  context: ApiRouteContext,
  userId: string,
  group: PersonalDeviceGroupRecord,
  signer: PdsAuthoritySigner
): Promise<void> => {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
  await Promise.all(
    group.members
      .filter((member) => member.status === "active")
      .map(async (member) => {
        const unsigned = {
          protocol: "koed/pds/v1",
          groupId: group.groupId,
          deviceId: member.deviceId,
          deviceSigningKeyId: member.signingKeyId,
          deviceSigningPublicKey: member.signingPublicKey,
          deviceKemKeyId: member.kemKeyId,
          deviceKemPublicKey: member.kemPublicKey,
          epoch: group.currentEpoch,
          operationFamilies: ["pds_relay"],
          statementSequence: group.headSequence,
          statementHash: group.headHash,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString()
        };
        const certificate = {
          ...unsigned,
          authoritySignature: {
            keyId: signer.keyId,
            signature: signPdsRecord(
              "membership-certificate",
              unsigned,
              signer.privateKey
            )
          }
        };
        await context
          .requireRepository()
          .storePersonalDeviceMembershipCertificate({
            userId,
            groupId: group.groupId,
            deviceId: member.deviceId,
            epoch: group.currentEpoch,
            statementSequence: group.headSequence,
            statementHash: group.headHash,
            authorityKeyId: signer.keyId,
            canonicalCertificate: canonicalizePdsJson(certificate),
            issuedAt,
            expiresAt
          });
      })
  );
};

const expectedBundleRecipients = (
  group: PersonalDeviceGroupRecord,
  kind: "add-device" | "revoke-device" | "recover",
  statementBody: Record<string, unknown>
): Array<{
  recipientId: string;
  recipientKind: "device" | "recovery";
  recipientKemKeyId: string;
  recipientKemPublicKeyCommitment: string;
}> => {
  let members: Array<{
    deviceId: string;
    kemKeyId: string;
    kemPublicKey: string;
  }> = group.members.filter((member) => member.status === "active");
  if (kind === "add-device" || kind === "recover")
    members = [...members, deviceFromBody(kind, statementBody)];
  const revokedDeviceIds =
    kind === "recover"
      ? (statementBody.revokedDeviceIds as string[])
      : kind === "revoke-device"
        ? [string(statementBody.deviceId, "deviceId")]
        : [];
  const recipients: Array<{
    recipientId: string;
    recipientKind: "device" | "recovery";
    recipientKemKeyId: string;
    recipientKemPublicKeyCommitment: string;
  }> = members
    .filter((member) => !revokedDeviceIds.includes(member.deviceId))
    .map((member) => ({
      recipientId: member.deviceId,
      recipientKind: "device" as const,
      recipientKemKeyId: member.kemKeyId,
      recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
        member.kemPublicKey
      )
    }));
  recipients.push({
    recipientId: group.recoveryKemKeyId,
    recipientKind: "recovery",
    recipientKemKeyId: group.recoveryKemKeyId,
    recipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
      group.recoveryKemPublicKey
    )
  });
  return recipients.sort((left, right) =>
    left.recipientId.localeCompare(right.recipientId)
  );
};

const assertUniqueKeyRoles = (
  group: PersonalDeviceGroupRecord,
  device: ReturnType<typeof deviceFromBody>
): void => {
  const ids = [
    group.authorityKeyId,
    group.recoverySigningKeyId,
    group.recoveryKemKeyId,
    ...group.members.flatMap((member) => [
      member.signingKeyId,
      member.kemKeyId
    ]),
    device.signingKeyId,
    device.kemKeyId
  ];
  const publicKeys = [
    group.authorityPublicKey,
    group.recoverySigningPublicKey,
    group.recoveryKemPublicKey,
    ...group.members.flatMap((member) => [
      member.signingPublicKey,
      member.kemPublicKey
    ]),
    device.signingPublicKey,
    device.kemPublicKey
  ];
  if (
    new Set(ids).size !== ids.length ||
    new Set(publicKeys).size !== publicKeys.length
  )
    throw pdsError("PDS key material is reused across roles");
};

export const registerPersonalDeviceSyncRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const sessionUser = (request: FastifyRequest) => {
    const scheme = request.headers.authorization
      ?.trim()
      .split(/\s+/, 1)[0]
      ?.toLowerCase();
    if (scheme === "bearer" || scheme === "koed-device")
      throw pdsError(
        "PDS governance requires browser session authentication",
        403
      );
    return context.auth.authenticateSession(request);
  };
  const repo = context.requireRepository;

  app.post(
    "/v1/personal-device-sync/challenges",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsChallengeSchema.parse(request.body);
      const challenge = randomBytes(32).toString("base64url");
      return {
        challenge: await repo().createPersonalDeviceEnrollmentChallenge({
          userId: user.id,
          groupId: input.group_id,
          browserSubjectId: user.id,
          browserDeploymentId: browserDeploymentId(context),
          challenge,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000)
        })
      };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/genesis",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const signer = pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsGenesisSchema.parse(request.body);
      const statement = parsedStatement(input.statement);
      const statementDraft = draft(statement);
      const statementBody = body(statement);
      if (
        statementDraft.kind !== "genesis" ||
        statementDraft.previousHash !== null ||
        statementDraft.sequence !== "1"
      )
        throw pdsError("PDS genesis head is invalid");
      if (
        statementBody.authorityKeyId !== signer.keyId ||
        statementBody.authorityPublicKey !== signer.publicKey
      )
        throw pdsError(
          "PDS genesis authority does not match configured authority",
          503
        );
      if (
        input.first_device.device_id !== input.proof.device_id ||
        input.first_device.signing_key_id !==
          statement.authorization.signerKeyId
      )
        throw pdsError("PDS first device authorization does not match proof");
      const firstDevice = {
        deviceId: input.first_device.device_id,
        signingKeyId: input.first_device.signing_key_id,
        signingPublicKey: input.first_device.signing_public_key,
        kemKeyId: input.first_device.kem_key_id,
        kemPublicKey: input.first_device.kem_public_key
      };
      if (
        new Set([
          signer.keyId,
          string(statementBody.recoverySigningKeyId, "recoverySigningKeyId"),
          string(statementBody.recoveryKemKeyId, "recoveryKemKeyId"),
          firstDevice.signingKeyId,
          firstDevice.kemKeyId
        ]).size !== 5 ||
        new Set([
          signer.publicKey,
          string(
            statementBody.recoverySigningPublicKey,
            "recoverySigningPublicKey"
          ),
          string(statementBody.recoveryKemPublicKey, "recoveryKemPublicKey"),
          firstDevice.signingPublicKey,
          firstDevice.kemPublicKey
        ]).size !== 5
      )
        throw pdsError("PDS key material is reused across roles");
      verifyPdsEnrollmentProof(
        enrollmentProof(
          input.proof,
          string(statementDraft.groupId, "groupId"),
          firstDevice,
          user.id,
          browserDeploymentId(context)
        )
      );
      validatePdsGroupStatement(statement, {
        authorizationPublicKey: input.first_device.signing_public_key,
        expectedGroupId: string(statementDraft.groupId, "groupId"),
        expectedPreviousHash: null,
        expectedSequence: "1"
      });
      const consumed = await repo().consumePersonalDeviceEnrollmentChallenge({
        userId: user.id,
        challengeId: input.proof.challenge_id,
        browserSubjectId: user.id,
        browserDeploymentId: browserDeploymentId(context),
        challenge: input.proof.challenge
      });
      if (!consumed)
        throw pdsError("PDS enrollment challenge is invalid or expired", 409);
      const finalized = counterSignStatement(statement, signer);
      validatePdsGroupStatement(finalized, {
        authorizationPublicKey: input.first_device.signing_public_key,
        authorityPublicKey: signer.publicKey,
        expectedGroupId: string(statementDraft.groupId, "groupId"),
        expectedPreviousHash: null,
        expectedSequence: "1"
      });
      const created = await repo().createPersonalDeviceGroup({
        userId: user.id,
        groupId: string(statementDraft.groupId, "groupId"),
        subjectId: user.id,
        subjectDeploymentId: browserDeploymentId(context),
        authorityKeyId: signer.keyId,
        authorityPublicKey: signer.publicKey,
        recoverySigningKeyId: string(
          statementBody.recoverySigningKeyId,
          "recoverySigningKeyId"
        ),
        recoverySigningPublicKey: string(
          statementBody.recoverySigningPublicKey,
          "recoverySigningPublicKey"
        ),
        recoveryKemKeyId: string(
          statementBody.recoveryKemKeyId,
          "recoveryKemKeyId"
        ),
        recoveryKemPublicKey: string(
          statementBody.recoveryKemPublicKey,
          "recoveryKemPublicKey"
        ),
        recoveryKitHash: string(
          statementBody.recoveryKitHash,
          "recoveryKitHash"
        ),
        initialEpoch: string(statementBody.initialEpoch, "initialEpoch"),
        statementHash: pdsFinalizedStatementHash(finalized),
        statement: canonicalizePdsJson(finalized),
        device: { ...firstDevice, operationFamilies: ["pds_relay"] }
      });
      if (!created) throw pdsError("PDS group creation conflicted", 409);
      await issueMembershipCertificates(context, user.id, created, signer);
      return { group: publicGroup(created), statement: finalized };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/:groupId/transitions",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      const signer = pdsAuthority(context);
      const user = await sessionUser(request);
      const params = pdsGroupParamsSchema.parse(request.params);
      const input = pdsTransitionSchema.parse(request.body);
      const group = await repo().getPersonalDeviceGroup(
        user.id,
        params.groupId
      );
      if (!group) throw pdsError("Personal Device Group not found", 404);
      if (
        group.authorityKeyId !== signer.keyId ||
        group.authorityPublicKey !== signer.publicKey
      )
        unavailable();
      if (group.state !== "active")
        throw pdsError("PDS governance is frozen", 409);
      if (group.pendingEpoch !== null)
        throw pdsError("PDS epoch activation is pending", 409);
      const statement = parsedStatement(input.statement);
      const statementDraft = draft(statement);
      const statementBody = body(statement);
      const kind = statementDraft.kind;
      if (!["add-device", "revoke-device", "recover"].includes(kind as string))
        throw pdsError("PDS transition kind is unsupported", 400);
      const authorKey = authorizationPublicKey(group, statement);
      if (
        statement.authorization.signerKeyId === group.recoverySigningKeyId &&
        kind !== "recover"
      )
        throw pdsError("PDS recovery signer may only recover", 403);
      validatePdsGroupStatement(statement, {
        authorizationPublicKey: authorKey,
        expectedAuthorizationKeyId: string(
          statement.authorization.signerKeyId,
          "signerKeyId"
        ),
        expectedGroupId: group.groupId
      });
      const expectedSequence = (BigInt(group.headSequence) + 1n).toString();
      if (
        statementDraft.previousHash !== group.headHash ||
        statementDraft.sequence !== expectedSequence
      ) {
        const statements = await repo().listPersonalDeviceGroupStatements(
          user.id,
          group.groupId
        );
        const currentSignedHead = statements.find(
          (entry) => entry.sequence === group.headSequence
        );
        return reply.code(409).send({
          conflict: true,
          group: publicGroup(group),
          head_statement: currentSignedHead?.canonicalStatement ?? null
        });
      }
      validatePdsGroupStatement(statement, {
        authorizationPublicKey: authorKey,
        expectedAuthorizationKeyId: string(
          statement.authorization.signerKeyId,
          "signerKeyId"
        ),
        expectedGroupId: group.groupId,
        expectedPreviousHash: group.headHash,
        expectedSequence
      });
      let keyBundle:
        | {
            hash: string;
            canonical: string;
            epoch: string;
            transitionKind: string;
            recipients: string[];
          }
        | undefined;
      if (["add-device", "revoke-device", "recover"].includes(kind as string)) {
        if (!input.key_bundle)
          throw pdsError("PDS membership transition requires key bundle");
        if ((kind === "add-device" || kind === "recover") && !input.proof)
          throw pdsError("PDS new device proof is required");
        const newDevice =
          kind === "add-device" || kind === "recover"
            ? deviceFromBody(kind, statementBody)
            : undefined;
        if (newDevice && input.proof) {
          if (input.proof.device_id !== newDevice.deviceId)
            throw pdsError("PDS proof device does not match transition");
          assertUniqueKeyRoles(group, newDevice);
          if (
            kind === "recover" &&
            !(statementBody.revokedDeviceIds as string[]).every((deviceId) =>
              group.members.some(
                (member) =>
                  member.deviceId === deviceId && member.status === "active"
              )
            )
          )
            throw pdsError("PDS recovery revoked device is not active", 409);
          verifyPdsEnrollmentProof(
            enrollmentProof(
              input.proof,
              group.groupId,
              newDevice,
              user.id,
              browserDeploymentId(context)
            )
          );
          const consumed =
            await repo().consumePersonalDeviceEnrollmentChallenge({
              userId: user.id,
              groupId: group.groupId,
              challengeId: input.proof.challenge_id,
              browserSubjectId: user.id,
              browserDeploymentId: browserDeploymentId(context),
              challenge: input.proof.challenge
            });
          if (!consumed)
            throw pdsError(
              "PDS enrollment challenge is invalid or expired",
              409
            );
        }
        const rawBundle = parseCanonicalPdsJson(input.key_bundle) as Record<
          string,
          unknown
        >;
        const recipientBindings = expectedBundleRecipients(
          group,
          kind as "add-device" | "revoke-device" | "recover",
          statementBody
        );
        const metadata = validatePdsKeyBundle(rawBundle, {
          authorizationPublicKey: authorKey,
          expectedAuthorizationKeyId: string(
            statement.authorization.signerKeyId,
            "signerKeyId"
          ),
          expectedRecipients: recipientBindings
        });
        if (
          metadata.draft.groupId !== group.groupId ||
          metadata.draft.epoch !== statementBody.nextEpoch ||
          metadata.draft.transitionKind !== kind
        )
          throw pdsError("PDS key bundle does not bind transition");
        const recipients = recipientBindings.map(
          (recipient) => recipient.recipientId
        );
        if (
          JSON.stringify(metadata.draft.recipientSnapshot) !==
          JSON.stringify(recipients)
        )
          throw pdsError("PDS key bundle recipient snapshot is incomplete");
        const authorization = rawBundle.authorization as Record<
          string,
          unknown
        >;
        const finalizedBundle = {
          draft: metadata.draft,
          authorization,
          authority: {
            keyId: signer.keyId,
            signature: signPdsTwoStageFinal(
              "key-bundle",
              { draft: metadata.draft, authorization },
              signer.privateKey
            )
          }
        };
        const finalMetadata = validatePdsKeyBundle(finalizedBundle, {
          authorizationPublicKey: authorKey,
          authorityPublicKey: signer.publicKey,
          expectedAuthorizationKeyId: string(
            statement.authorization.signerKeyId,
            "signerKeyId"
          ),
          expectedAuthorityKeyId: signer.keyId,
          expectedRecipients: recipientBindings
        });
        keyBundle = {
          hash: finalMetadata.hash,
          canonical: canonicalizePdsJson(finalizedBundle),
          epoch: string(finalMetadata.draft.epoch, "epoch"),
          transitionKind: string(
            finalMetadata.draft.transitionKind,
            "transitionKind"
          ),
          recipients
        };
        if (keyBundle.hash !== statementBody.keyBundleHash)
          throw pdsError("PDS statement key bundle hash does not match");
      }
      const finalized = counterSignStatement(statement, signer);
      validatePdsGroupStatement(finalized, {
        authorizationPublicKey: authorKey,
        authorityPublicKey: signer.publicKey,
        expectedGroupId: group.groupId,
        expectedPreviousHash: group.headHash,
        expectedSequence: (BigInt(group.headSequence) + 1n).toString()
      });
      const transition = await repo().commitPersonalDeviceTransition({
        userId: user.id,
        groupId: group.groupId,
        expectedHeadHash: group.headHash,
        sequence: string(statementDraft.sequence, "sequence"),
        nextEpoch: ["add-device", "revoke-device", "recover"].includes(
          kind as string
        )
          ? string(statementBody.nextEpoch, "nextEpoch")
          : null,
        kind: kind as "add-device" | "revoke-device" | "recover",
        statementHash: pdsFinalizedStatementHash(finalized),
        statement: canonicalizePdsJson(finalized),
        authorizationKeyId: string(
          statement.authorization.signerKeyId,
          "signerKeyId"
        ),
        browserSubjectId: user.id,
        browserDeploymentId: browserDeploymentId(context),
        keyBundle,
        addedDevice:
          kind === "add-device" || kind === "recover"
            ? deviceFromBody(kind, statementBody)
            : undefined,
        revokeDeviceIds:
          kind === "revoke-device"
            ? [string(statementBody.deviceId, "deviceId")]
            : kind === "recover"
              ? (statementBody.revokedDeviceIds as string[])
              : undefined
      });
      if (!transition) throw pdsError("Personal Device Group not found", 404);
      if (transition.outcome !== "accepted")
        return {
          conflict: true,
          group: publicGroup(transition.group),
          head_statement: transition.statement
        };
      return {
        group: publicGroup(transition.group),
        statement: finalized,
        ...(keyBundle
          ? { key_bundle: parseCanonicalPdsJson(keyBundle.canonical) }
          : {})
      };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/:groupId/epoch-acks",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const signer = pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const input = pdsEpochAckSchema.parse(request.body);
      const group = await repo().getPersonalDeviceGroup(user.id, groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      if (
        !group.pendingEpoch ||
        !group.pendingStatementSequence ||
        !group.pendingStatementHash ||
        !group.pendingBundleHash
      )
        throw pdsError("PDS epoch acknowledgement has no pending epoch", 409);
      const ack = parseCanonicalPdsJson(input.ack) as Record<string, unknown>;
      const deviceId = string(ack.deviceId, "deviceId");
      const member = group.members.find(
        (candidate) =>
          candidate.deviceId === deviceId && candidate.status === "active"
      );
      if (!member)
        throw pdsError("PDS epoch acknowledgement device is not active", 403);
      const validatedAck = validatePdsKeyBundleAck(ack, {
        signingPublicKey: member.signingPublicKey,
        expectedSignerKeyId: member.signingKeyId,
        expectedGroupId: group.groupId,
        expectedDeviceId: member.deviceId,
        expectedEpoch: group.pendingEpoch,
        expectedBundleHash: group.pendingBundleHash,
        expectedRecipientKemKeyId: member.kemKeyId,
        expectedRecipientKemPublicKeyCommitment: pdsPublicKeyCommitment(
          member.kemPublicKey
        )
      });
      const result = await repo().acknowledgePersonalDeviceEpoch({
        userId: user.id,
        groupId,
        deviceId,
        epoch: group.pendingEpoch,
        canonicalAck: canonicalizePdsJson(ack),
        acknowledgedAt: validatedAck.acknowledgedAt
      });
      if (!result) throw pdsError("PDS epoch acknowledgement is stale", 409);
      if (result.activated)
        await issueMembershipCertificates(
          context,
          user.id,
          result.group,
          signer
        );
      return { group: publicGroup(result.group), activated: result.activated };
    }
  );

  app.get(
    "/v1/personal-device-sync/groups/:groupId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const group = await repo().getPersonalDeviceGroup(user.id, groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      return { group: publicGroup(group) };
    }
  );
  app.get(
    "/v1/personal-device-sync/groups/:groupId/key-bundles/:epoch",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsKeyBundleParamsSchema.parse(request.params);
      const keyBundle = await repo().getPersonalDeviceKeyBundle({
        userId: user.id,
        groupId: input.groupId,
        epoch: input.epoch
      });
      if (!keyBundle) throw pdsError("PDS key bundle is unavailable", 404);
      return { key_bundle: parseCanonicalPdsJson(keyBundle) };
    }
  );
  app.get(
    "/v1/personal-device-sync/groups/:groupId/certificates/:deviceId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsCertificateParamsSchema.parse(request.params);
      const certificate = await repo().getPersonalDeviceMembershipCertificate({
        userId: user.id,
        groupId: input.groupId,
        deviceId: input.deviceId
      });
      if (!certificate)
        throw pdsError("PDS membership certificate is unavailable", 404);
      return { certificate: parseCanonicalPdsJson(certificate) };
    }
  );
  app.get(
    "/v1/personal-device-sync/groups/:groupId/status",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const group = await repo().getPersonalDeviceGroup(user.id, groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      return {
        group_id: group.groupId,
        current_epoch: group.currentEpoch,
        pending_epoch: group.pendingEpoch,
        pending_statement_sequence: group.pendingStatementSequence,
        pending_bundle_hash: group.pendingBundleHash,
        state: group.state
      };
    }
  );
  app.get(
    "/v1/personal-device-sync/groups/:groupId/log",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const group = await repo().getPersonalDeviceGroup(user.id, groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      return {
        statements: await repo().listPersonalDeviceGroupStatements(
          user.id,
          groupId
        )
      };
    }
  );
  app.put(
    "/v1/personal-device-sync/groups/:groupId/policy",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const input = pdsPolicySchema.parse(request.body);
      const group = await repo().updatePersonalSyncPolicy(
        user.id,
        groupId,
        input.enabled
      );
      if (!group) throw pdsError("Personal Device Group not found", 404);
      return { policy: publicGroup(group).policy };
    }
  );
  app.post(
    "/v1/personal-device-sync/groups/:groupId/sessions/:sessionId/close",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsCloseSessionParamsSchema.parse(request.params);
      const secureKeys = context.personalDeviceSync.secureKeyProvider;
      const envelope = context.encryption.envelopeEncryptionProvider;
      if (!secureKeys || !envelope) {
        throw pdsError("PDS secure publication path is unavailable", 503);
      }
      const keyContext = await secureKeys.getSourceContext({
        userId: user.id,
        groupId: input.groupId
      });
      if (!keyContext)
        throw pdsError("PDS secure key context is unavailable", 503);
      const closure = await repo().closePdsSourceSession({
        userId: user.id,
        groupId: input.groupId,
        sessionId: input.sessionId,
        originDeploymentId: keyContext.originDeploymentId,
        originDeviceId: keyContext.originDeviceId,
        async build({ source, sourceSequence, closedAt }) {
          const built = await keyContext.buildClosedSessionPackage({
            source,
            sourceSequence,
            items: pdsConversationItemsForClosure(source),
            closedAt
          });
          const packageId = built.package.header.packageId;
          const sourceManifestHash = built.package.header.sourceManifestHash;
          if (
            sourceManifestHash !== built.sourceManifestHash ||
            built.package.packageDigest !==
              pdsSessionPackageDigest({
                header: built.package.header,
                envelopes: built.package.envelopes,
                chunks: built.package.chunks
              })
          ) {
            throw pdsError("PDS secure package identity binding failed", 409);
          }
          return {
            sourceClosureHash: built.sourceClosureHash,
            packageId,
            sourceManifestHash,
            encryptedEnvelope: await envelope.encrypt({
              plaintext: JSON.stringify(built.package),
              scope: { tenantId: user.id, objectClass: "pds_source_package" },
              provenance: {
                rowFamily: "pds_retained_packages",
                sourceTable: "pds_retained_packages",
                sourceId: packageId
              },
              ciphertextLocation: "pds_retained_packages",
              aad: { ownerUserId: user.id, groupId: input.groupId, packageId }
            })
          };
        }
      });
      return {
        closure: {
          source_sequence: closure.sourceSequence,
          state: closure.state
        }
      };
    }
  );
  app.post(
    "/v1/personal-device-sync/groups/:groupId/retry",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      return {
        retried: await repo().requestPdsOutboxRetry({
          userId: user.id,
          groupId
        })
      };
    }
  );
  app.put(
    "/v1/personal-device-sync/groups/:groupId/pause",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const { paused } = pdsPauseSchema.parse(request.body);
      return {
        paused,
        updated: await repo().setPdsPublicationPaused({
          userId: user.id,
          groupId,
          paused
        })
      };
    }
  );
  app.get(
    "/v1/personal-device-sync/groups/:groupId/local-status",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const status = await repo().getPdsLocalSyncStatus({
        userId: user.id,
        groupId
      });
      if (!status) throw pdsError("Personal Device Group not found", 404);
      return { status };
    }
  );
  app.post(
    "/v1/personal-device-sync/groups/:groupId/remote-account-links",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const input = pdsRemoteAccountLinkSchema.parse(request.body);
      const verifier = context.personalDeviceSync.remoteAccountLinkVerifier;
      if (!verifier)
        throw pdsError("Remote Account Link provider is unavailable", 503);
      let verified: Awaited<
        ReturnType<typeof verifier.resolveRemoteAccountProof>
      >;
      try {
        verified = await verifier.resolveRemoteAccountProof(input.proof_token);
      } catch {
        throw pdsError("Remote Account Link proof is invalid", 403);
      }
      if (
        !verified.issuer ||
        !verified.deploymentId ||
        !verified.subjectId ||
        !verified.nonce ||
        !(verified.expiresAt instanceof Date) ||
        !Number.isFinite(verified.expiresAt.getTime()) ||
        verified.expiresAt <= new Date() ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(verified.subjectId)
      )
        throw pdsError("Remote Account Link proof is invalid", 403);
      const link = await repo().createRemoteAccountLink({
        userId: user.id,
        groupId,
        remoteIssuer: verified.issuer,
        remoteDeploymentId: verified.deploymentId,
        remoteSubjectId: verified.subjectId,
        nonce: verified.nonce,
        expiresAt: verified.expiresAt
      });
      if (!link) throw pdsError("Personal Device Group not found", 404);
      return {
        remote_account_link: {
          id: link.id,
          remote_deployment_id: link.remoteDeploymentId,
          remote_subject_id: link.remoteSubjectId,
          sync_enabled: false
        }
      };
    }
  );
};
