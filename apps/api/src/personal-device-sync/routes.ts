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
  verifyPdsEnrollmentProof,
  type PdsGroupStatement
} from "@koed/shared";
import type { PersonalDeviceGroupRecord } from "@koed/db";
import type { ApiRouteContext } from "../server/context.js";
import {
  pdsChallengeSchema,
  pdsGenesisSchema,
  pdsGroupParamsSchema,
  pdsPolicySchema,
  pdsRemoteAccountLinkSchema,
  pdsTransitionSchema
} from "./schemas.js";

export interface PdsAuthoritySigner {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
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
  statementBody: Record<string, unknown>,
  replacementDeviceId?: string
) => ({
  deviceId:
    transition === "add-device"
      ? string(statementBody.deviceId, "deviceId")
      : (replacementDeviceId ??
        string(statementBody.deviceSigningKeyId, "replacement device id")),
  signingKeyId: string(statementBody.deviceSigningKeyId, "deviceSigningKeyId"),
  signingPublicKey: string(
    statementBody.deviceSigningPublicKey,
    "deviceSigningPublicKey"
  ),
  kemKeyId: string(statementBody.deviceKemKeyId, "deviceKemKeyId"),
  kemPublicKey: string(statementBody.deviceKemPublicKey, "deviceKemPublicKey"),
  operationFamilies: ["pds_relay"]
});

const enrollmentProof = (
  proof: {
    challenge_id: string;
    challenge: string;
    device_id: string;
    signature: string;
  },
  groupId: string | undefined,
  deviceSigningPublicKey: string
) => ({
  challengeId: proof.challenge_id,
  challenge: proof.challenge,
  deviceId: proof.device_id,
  signature: proof.signature,
  groupId,
  deviceSigningPublicKey
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
  kind: string,
  statementBody: Record<string, unknown>,
  replacementDeviceId?: string
): string[] => {
  let recipients = group.members
    .filter((member) => member.status === "active")
    .map((member) => member.deviceId);
  if (kind === "add-device" || kind === "recover")
    recipients.push(
      deviceFromBody(kind, statementBody, replacementDeviceId).deviceId
    );
  if (kind === "revoke-device")
    recipients = recipients.filter(
      (id) => id !== string(statementBody.deviceId, "deviceId")
    );
  recipients.push(group.recoveryKemKeyId);
  return [...new Set(recipients)].sort();
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
      verifyPdsEnrollmentProof(
        enrollmentProof(
          input.proof,
          string(statementDraft.groupId, "groupId"),
          input.first_device.signing_public_key
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
        device: {
          deviceId: input.first_device.device_id,
          signingKeyId: input.first_device.signing_key_id,
          signingPublicKey: input.first_device.signing_public_key,
          kemKeyId: input.first_device.kem_key_id,
          kemPublicKey: input.first_device.kem_public_key,
          operationFamilies: ["pds_relay"]
        }
      });
      if (!created) throw pdsError("PDS group creation conflicted", 409);
      await issueMembershipCertificates(context, user.id, created, signer);
      return { group: publicGroup(created), statement: finalized };
    }
  );

  app.post(
    "/v1/personal-device-sync/groups/:groupId/transitions",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
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
      const expectedSequence = (BigInt(group.headSequence) + 1n).toString();
      if (
        statementDraft.previousHash !== group.headHash ||
        statementDraft.sequence !== expectedSequence
      ) {
        const statements = await repo().listPersonalDeviceGroupStatements(
          user.id,
          group.groupId
        );
        const existing = statements.find(
          (entry) => entry.sequence === statementDraft.sequence
        );
        const currentSignedHead = statements.find(
          (entry) => entry.sequence === group.headSequence
        );
        if (existing) {
          const existingStatement = parsedStatement(
            existing.canonicalStatement
          );
          const sameStatement =
            canonicalizePdsJson({
              draft: draft(existingStatement),
              authorization: existingStatement.authorization
            }) ===
            canonicalizePdsJson({
              draft: statementDraft,
              authorization: statement.authorization
            });
          if (sameStatement) {
            return {
              conflict: true,
              group: publicGroup(group),
              head_statement: currentSignedHead?.canonicalStatement ?? null
            };
          }
        }
        const frozen = await repo().freezePersonalDeviceGovernance({
          userId: user.id,
          groupId: group.groupId,
          reason: existing ? "same_sequence_fork" : "broken_chain",
          actorKeyId:
            typeof statement.authorization?.signerKeyId === "string"
              ? statement.authorization.signerKeyId
              : undefined
        });
        return {
          conflict: true,
          group: publicGroup(frozen ?? group),
          head_statement: currentSignedHead?.canonicalStatement ?? null
        };
      }
      const kind = statementDraft.kind;
      if (
        ![
          "add-device",
          "revoke-device",
          "recover",
          "tombstone",
          "resolve-conflict"
        ].includes(kind as string)
      )
        throw pdsError("PDS transition kind is invalid");
      const authorKey = authorizationPublicKey(group, statement);
      validatePdsGroupStatement(statement, {
        authorizationPublicKey: authorKey,
        expectedGroupId: group.groupId,
        expectedPreviousHash: group.headHash,
        expectedSequence: (BigInt(group.headSequence) + 1n).toString()
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
            ? deviceFromBody(kind, statementBody, input.replacement_device_id)
            : undefined;
        if (newDevice && input.proof) {
          if (input.proof.device_id !== newDevice.deviceId)
            throw pdsError("PDS proof device does not match transition");
          verifyPdsEnrollmentProof(
            enrollmentProof(
              input.proof,
              group.groupId,
              newDevice.signingPublicKey
            )
          );
          const consumed =
            await repo().consumePersonalDeviceEnrollmentChallenge({
              userId: user.id,
              groupId: group.groupId,
              challengeId: input.proof.challenge_id,
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
        const metadata = validatePdsKeyBundle(rawBundle, {
          authorizationPublicKey: authorKey
        });
        if (
          metadata.draft.groupId !== group.groupId ||
          metadata.draft.epoch !== statementBody.nextEpoch ||
          metadata.draft.transitionKind !== kind
        )
          throw pdsError("PDS key bundle does not bind transition");
        const recipients = expectedBundleRecipients(
          group,
          kind as string,
          statementBody,
          input.replacement_device_id
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
          authorityPublicKey: signer.publicKey
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
        kind: kind as
          | "add-device"
          | "revoke-device"
          | "recover"
          | "tombstone"
          | "resolve-conflict",
        statementHash: pdsFinalizedStatementHash(finalized),
        statement: canonicalizePdsJson(finalized),
        authorizationKeyId: string(
          statement.authorization.signerKeyId,
          "signerKeyId"
        ),
        keyBundle,
        addedDevice:
          kind === "add-device" || kind === "recover"
            ? deviceFromBody(kind, statementBody, input.replacement_device_id)
            : undefined,
        revokeDeviceId:
          kind === "revoke-device"
            ? string(statementBody.deviceId, "deviceId")
            : undefined
      });
      if (!transition) throw pdsError("Personal Device Group not found", 404);
      if (transition.outcome !== "accepted")
        return {
          conflict: true,
          group: publicGroup(transition.group),
          head_statement: transition.statement
        };
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
      const link = await repo().createRemoteAccountLink({
        userId: user.id,
        groupId,
        remoteDeploymentId: input.remote_deployment_id,
        remoteSubjectId: input.remote_subject_id,
        remoteProofReference: input.remote_subject_proof_reference
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
