import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson,
  pdsFinalizedStatementHash,
  signPdsGroupFinal,
  signPdsRecord,
  signPdsTwoStageFinal,
  validatePdsGroupStatement,
  validatePdsKeyBundle,
  validatePdsKeyBundleMetadata,
  verifyPdsEnrollmentProof,
  type PdsGroupStatement
} from "@koed/shared";
import type { PersonalDeviceGroupRecord } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  pdsCertificateParamsSchema,
  pdsChallengeSchema,
  pdsGenesisSchema,
  pdsGroupParamsSchema,
  pdsKeyBundleFinalizeSchema,
  pdsKeyBundleParamsSchema,
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
const pdsInput = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw pdsError(
      error instanceof Error ? error.message : "PDS record is invalid"
    );
  }
};
const parsedPdsJson = (input: string): unknown =>
  pdsInput(() => parseCanonicalPdsJson(input));
const parsedStatement = (input: string): PdsGroupStatement =>
  parsedPdsJson(input) as PdsGroupStatement;
const validatedGroupStatement = (
  value: unknown,
  options: Parameters<typeof validatePdsGroupStatement>[1]
): PdsGroupStatement =>
  pdsInput(() => validatePdsGroupStatement(value, options));
const validatedKeyBundleMetadata = (
  value: unknown
): ReturnType<typeof validatePdsKeyBundleMetadata> =>
  pdsInput(() => validatePdsKeyBundleMetadata(value));
const validatedKeyBundle = (
  value: unknown,
  options: Parameters<typeof validatePdsKeyBundle>[1]
): ReturnType<typeof validatePdsKeyBundle> =>
  pdsInput(() => validatePdsKeyBundle(value, options));
const verifiedEnrollmentProof = (
  input: Parameters<typeof verifyPdsEnrollmentProof>[0]
): void => pdsInput(() => verifyPdsEnrollmentProof(input));
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

const authorizationPublicKeyFor = (
  group: PersonalDeviceGroupRecord,
  keyId: string,
  includeRevoked = false
): string => {
  if (keyId === group.recoverySigningKeyId)
    return group.recoverySigningPublicKey;
  const member = group.members.find(
    (item) =>
      item.signingKeyId === keyId &&
      (includeRevoked || item.status === "active")
  );
  if (!member) throw pdsError("PDS authorization signer is not active", 403);
  return member.signingPublicKey;
};

const authorizationPublicKey = (
  group: PersonalDeviceGroupRecord,
  statement: PdsGroupStatement
): string =>
  authorizationPublicKeyFor(
    group,
    string(statement.authorization?.signerKeyId, "authorization signer"),
    statement.authority !== undefined
  );

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
  signer: PdsAuthoritySigner,
  deviceId?: string
): Promise<void> => {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const members = group.members.filter(
    (member) =>
      member.status === "active" &&
      (deviceId === undefined || member.deviceId === deviceId)
  );
  if (deviceId !== undefined && members.length !== 1)
    throw pdsError("PDS member is not active", 409);
  await Promise.all(
    members.map(async (member) => {
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
  statementBody: Record<string, unknown>,
  recoveryRecipientId: string
): Array<{
  recipientId: string;
  recipientKind: "device" | "recovery";
  recipientKemKeyId: string;
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
      ? group.members
          .filter((member) => member.status === "active")
          .map((member) => member.deviceId)
      : kind === "revoke-device"
        ? [string(statementBody.deviceId, "deviceId")]
        : [];
  const recipients: Array<{
    recipientId: string;
    recipientKind: "device" | "recovery";
    recipientKemKeyId: string;
  }> = members
    .filter((member) => !revokedDeviceIds.includes(member.deviceId))
    .map((member) => ({
      recipientId: member.deviceId,
      recipientKind: "device" as const,
      recipientKemKeyId: member.kemKeyId
    }));
  recipients.push({
    recipientId: recoveryRecipientId,
    recipientKind: "recovery",
    recipientKemKeyId: group.recoveryKemKeyId
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
  if (group.members.some((member) => member.deviceId === device.deviceId))
    throw pdsError("PDS device identity is already present", 409);
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
          browserDeploymentId: input.device_deployment_id,
          challenge,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000)
        })
      };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/genesis",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
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
      const firstDevice = {
        deviceId: string(statementBody.initialDeviceId, "initialDeviceId"),
        signingKeyId: string(
          statementBody.initialDeviceSigningKeyId,
          "initialDeviceSigningKeyId"
        ),
        signingPublicKey: string(
          statementBody.initialDeviceSigningPublicKey,
          "initialDeviceSigningPublicKey"
        ),
        kemKeyId: string(
          statementBody.initialDeviceKemKeyId,
          "initialDeviceKemKeyId"
        ),
        kemPublicKey: string(
          statementBody.initialDeviceKemPublicKey,
          "initialDeviceKemPublicKey"
        )
      };
      if (
        firstDevice.deviceId !== input.proof.device_id ||
        firstDevice.signingKeyId !== statement.authorization.signerKeyId
      )
        throw pdsError("PDS first device authorization does not match proof");
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
      verifiedEnrollmentProof(
        enrollmentProof(
          input.proof,
          string(statementDraft.groupId, "groupId"),
          firstDevice,
          user.id,
          input.proof.device_deployment_id
        )
      );
      validatedGroupStatement(statement, {
        authorizationPublicKey: firstDevice.signingPublicKey,
        expectedGroupId: string(statementDraft.groupId, "groupId"),
        expectedPreviousHash: null,
        expectedSequence: "1"
      });
      const finalized = counterSignStatement(statement, signer);
      validatedGroupStatement(finalized, {
        authorizationPublicKey: firstDevice.signingPublicKey,
        authorityPublicKey: signer.publicKey,
        expectedGroupId: string(statementDraft.groupId, "groupId"),
        expectedPreviousHash: null,
        expectedSequence: "1"
      });
      const created = await repo().createPersonalDeviceGroup({
        userId: user.id,
        groupId: string(statementDraft.groupId, "groupId"),
        subjectId: user.id,
        subjectDeploymentId: input.proof.device_deployment_id,
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
        enrollmentChallenge: {
          challengeId: input.proof.challenge_id,
          browserSubjectId: user.id,
          browserDeploymentId: input.proof.device_deployment_id,
          challenge: input.proof.challenge
        },
        device: { ...firstDevice, operationFamilies: ["pds_relay"] }
      });
      if (created.outcome === "conflict")
        return reply.code(409).send({
          conflict: true,
          group: publicGroup(created.group),
          head_statement: created.statement
        });
      await issueMembershipCertificates(
        context,
        user.id,
        created.group,
        signer
      );
      return {
        group: publicGroup(created.group),
        statement: parsedStatement(created.statement)
      };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/:groupId/key-bundles/finalize",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const signer = pdsAuthority(context);
      const user = await sessionUser(request);
      const { groupId } = pdsGroupParamsSchema.parse(request.params);
      const input = pdsKeyBundleFinalizeSchema.parse(request.body);
      const group = await repo().getPersonalDeviceGroup(user.id, groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      if (
        group.authorityKeyId !== signer.keyId ||
        group.authorityPublicKey !== signer.publicKey
      )
        unavailable();
      if (group.state !== "active")
        throw pdsError("PDS governance is frozen", 409);
      const rawBundle = parsedPdsJson(input.key_bundle) as Record<
        string,
        unknown
      >;
      if ("authority" in rawBundle)
        throw pdsError("PDS key bundle is already countersigned", 409);
      const metadata = validatedKeyBundleMetadata(rawBundle);
      if (
        metadata.draft.groupId !== group.groupId ||
        metadata.draft.epoch !== (BigInt(group.currentEpoch) + 1n).toString()
      )
        throw pdsError("PDS key bundle does not bind the next group epoch");
      const transitionKind = string(
        metadata.draft.transitionKind,
        "transitionKind"
      );
      const authorization = rawBundle.authorization as Record<string, unknown>;
      const authorizationKeyId = string(
        authorization.signerKeyId,
        "signerKeyId"
      );
      if (
        authorizationKeyId === group.recoverySigningKeyId &&
        transitionKind !== "recover"
      )
        throw pdsError("PDS recovery signer may only recover", 403);
      const authorKey = authorizationPublicKeyFor(group, authorizationKeyId);
      validatedKeyBundle(rawBundle, {
        authorizationPublicKey: authorKey,
        expectedAuthorizationKeyId: authorizationKeyId
      });
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
      const finalized = validatedKeyBundle(finalizedBundle, {
        authorizationPublicKey: authorKey,
        authorityPublicKey: signer.publicKey,
        expectedAuthorizationKeyId: authorizationKeyId,
        expectedAuthorityKeyId: signer.keyId
      });
      return {
        key_bundle: finalizedBundle,
        key_bundle_hash: finalized.hash
      };
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
      const statement = parsedStatement(input.statement);
      const statementDraft = draft(statement);
      const statementBody = body(statement);
      const kind = statementDraft.kind;
      if (!["add-device", "revoke-device", "recover"].includes(kind as string))
        throw pdsError("PDS transition kind is unsupported", 400);
      const previousEpoch = string(
        statementBody.previousEpoch,
        "previousEpoch"
      );
      const nextEpoch = string(statementBody.nextEpoch, "nextEpoch");
      if (
        previousEpoch !== group.currentEpoch ||
        nextEpoch !== (BigInt(group.currentEpoch) + 1n).toString()
      )
        throw pdsError("PDS membership epoch is stale", 409);
      const recoveryKitHash =
        kind === "recover"
          ? string(statementBody.recoveryKitHash, "recoveryKitHash")
          : null;
      if (kind === "recover" && recoveryKitHash !== group.recoveryKitHash)
        throw pdsError(
          "PDS recovery kit does not match genesis commitment",
          409
        );
      const authorKey = authorizationPublicKey(group, statement);
      if (
        statement.authorization.signerKeyId === group.recoverySigningKeyId &&
        kind !== "recover"
      )
        throw pdsError("PDS recovery signer may only recover", 403);
      validatedGroupStatement(statement, {
        authorizationPublicKey: authorKey,
        ...(statement.authority
          ? {
              authorityPublicKey: signer.publicKey,
              expectedAuthorityKeyId: signer.keyId
            }
          : {}),
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
        const sameSequence = statements.find(
          (entry) => entry.sequence === statementDraft.sequence
        );
        if (
          statement.authority &&
          sameSequence &&
          sameSequence.canonicalStatement !== canonicalizePdsJson(statement)
        ) {
          const frozen = await repo().freezePersonalDeviceGovernance({
            userId: user.id,
            groupId: group.groupId,
            reason: "authority_same_sequence_conflict",
            actorKeyId: string(
              statement.authorization.signerKeyId,
              "signerKeyId"
            )
          });
          return reply.code(409).send({
            conflict: true,
            equivocation_freeze: true,
            group: publicGroup(frozen ?? group),
            head_statement: currentSignedHead?.canonicalStatement ?? null
          });
        }
        return reply.code(409).send({
          conflict: true,
          group: publicGroup(group),
          head_statement: currentSignedHead?.canonicalStatement ?? null
        });
      }
      validatedGroupStatement(statement, {
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
            recoveryRecipientId: string;
          }
        | undefined;
      let enrollmentChallenge:
        | {
            challengeId: string;
            groupId: string;
            browserSubjectId: string;
            browserDeploymentId: string;
            challenge: string;
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
          verifiedEnrollmentProof(
            enrollmentProof(
              input.proof,
              group.groupId,
              newDevice,
              user.id,
              input.proof.device_deployment_id
            )
          );
          enrollmentChallenge = {
            groupId: group.groupId,
            challengeId: input.proof.challenge_id,
            browserSubjectId: user.id,
            browserDeploymentId: input.proof.device_deployment_id,
            challenge: input.proof.challenge
          };
        }
        const rawBundle = parsedPdsJson(input.key_bundle) as Record<
          string,
          unknown
        >;
        const unverifiedMetadata = validatedKeyBundleMetadata(rawBundle);
        const recoveryEnvelopes = (
          unverifiedMetadata.draft.envelopes as Array<Record<string, unknown>>
        ).filter(
          (envelope) =>
            envelope.recipientKind === "recovery" &&
            envelope.recipientKemKeyId === group.recoveryKemKeyId
        );
        if (recoveryEnvelopes.length !== 1)
          throw pdsError("PDS key bundle recovery recipient is invalid");
        const recipientBindings = expectedBundleRecipients(
          group,
          kind as "add-device" | "revoke-device" | "recover",
          statementBody,
          string(recoveryEnvelopes[0]?.recipientId, "recoveryRecipientId")
        );
        const metadata = validatedKeyBundle(rawBundle, {
          authorizationPublicKey: authorKey,
          authorityPublicKey: signer.publicKey,
          expectedAuthorizationKeyId: string(
            statement.authorization.signerKeyId,
            "signerKeyId"
          ),
          expectedAuthorityKeyId: signer.keyId,
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
        keyBundle = {
          hash: metadata.hash,
          canonical: canonicalizePdsJson(rawBundle),
          epoch: string(metadata.draft.epoch, "epoch"),
          transitionKind: string(
            metadata.draft.transitionKind,
            "transitionKind"
          ),
          recipients,
          recoveryRecipientId: string(
            recoveryEnvelopes[0]?.recipientId,
            "recoveryRecipientId"
          )
        };
        if (keyBundle.hash !== statementBody.keyBundleHash)
          throw pdsError("PDS statement key bundle hash does not match");
      }
      const finalized = counterSignStatement(statement, signer);
      validatedGroupStatement(finalized, {
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
        kind: kind as "add-device" | "revoke-device" | "recover",
        statementHash: pdsFinalizedStatementHash(finalized),
        statement: canonicalizePdsJson(finalized),
        authorizationKeyId: string(
          statement.authorization.signerKeyId,
          "signerKeyId"
        ),
        enrollmentChallenge,
        addedDeviceSubject:
          kind === "add-device" || kind === "recover"
            ? {
                subjectId: user.id,
                deploymentId: input.proof!.device_deployment_id
              }
            : undefined,
        keyBundle,
        addedDevice:
          kind === "add-device" || kind === "recover"
            ? deviceFromBody(kind, statementBody)
            : undefined,
        revokeDeviceIds:
          kind === "revoke-device"
            ? [string(statementBody.deviceId, "deviceId")]
            : kind === "recover"
              ? group.members
                  .filter((member) => member.status === "active")
                  .map((member) => member.deviceId)
              : undefined
      });
      if (!transition) throw pdsError("Personal Device Group not found", 404);
      if (transition.outcome !== "accepted")
        return reply.code(409).send({
          conflict: true,
          group: publicGroup(transition.group),
          head_statement: transition.statement
        });
      await issueMembershipCertificates(
        context,
        user.id,
        transition.group,
        signer
      );
      return {
        group: publicGroup(transition.group),
        statement: finalized,
        ...(keyBundle
          ? { key_bundle: parseCanonicalPdsJson(keyBundle.canonical) }
          : {})
      };
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
  app.post(
    "/v1/personal-device-sync/groups/:groupId/certificates/:deviceId/renew",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const signer = pdsAuthority(context);
      const user = await sessionUser(request);
      const input = pdsCertificateParamsSchema.parse(request.params);
      const group = await repo().getPersonalDeviceGroup(user.id, input.groupId);
      if (!group) throw pdsError("Personal Device Group not found", 404);
      if (
        group.authorityKeyId !== signer.keyId ||
        group.authorityPublicKey !== signer.publicKey
      )
        unavailable();
      await issueMembershipCertificates(
        context,
        user.id,
        group,
        signer,
        input.deviceId
      );
      const certificate = await repo().getPersonalDeviceMembershipCertificate({
        userId: user.id,
        groupId: input.groupId,
        deviceId: input.deviceId
      });
      if (!certificate)
        throw pdsError("PDS membership certificate is unavailable", 503);
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
