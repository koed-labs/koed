import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { auditEventValues } from "./audit-repository.js";
import type { KoedDb } from "./connection.js";
import {
  auditEvents,
  deviceCredentials,
  deviceEnrollmentChallenges,
  users
} from "./schema.js";
import type {
  ActorContext,
  DeviceCredentialAuthContext,
  DeviceCredentialRecord,
  DeviceEnrollmentChallengeRecord,
  UserRecord
} from "./types.js";
import { mapUserRecord } from "./user-api-token-repository.js";

const mapChallengeRecord = (row: {
  id: string;
  upstreamBackendId: string;
  deviceInstanceId: string | null;
  deviceLabel: string | null;
  requestedOperationFamilies: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
  boundByUserId: string | null;
  boundAt: Date | null;
  redeemedAt: Date | null;
}): DeviceEnrollmentChallengeRecord => ({
  id: row.id,
  upstreamBackendId: row.upstreamBackendId,
  deviceInstanceId: row.deviceInstanceId,
  deviceLabel: row.deviceLabel,
  requestedOperationFamilies: row.requestedOperationFamilies,
  metadata: row.metadata,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  boundByUserId: row.boundByUserId,
  boundAt: row.boundAt?.toISOString() ?? null,
  redeemedAt: row.redeemedAt?.toISOString() ?? null
});

const mapDeviceCredentialRecord = (row: {
  id: string;
  ownerUserId: string;
  enrollmentChallengeId: string | null;
  credentialKeyId: string;
  upstreamBackendId: string;
  deviceInstanceId: string;
  deviceLabel: string | null;
  credentialVersion: number;
  verifierKind: "secret_hash" | "public_key_jwk";
  operationFamilies: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  lastValidatedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
}): DeviceCredentialRecord => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  enrollmentChallengeId: row.enrollmentChallengeId,
  credentialKeyId: row.credentialKeyId,
  upstreamBackendId: row.upstreamBackendId,
  deviceInstanceId: row.deviceInstanceId,
  deviceLabel: row.deviceLabel,
  credentialVersion: row.credentialVersion,
  verifierKind: row.verifierKind,
  operationFamilies: row.operationFamilies,
  metadata: row.metadata,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  revokedByUserId: row.revokedByUserId,
  revocationReason: row.revocationReason
});

const deviceCredentialAuditMetadata = (
  credential: Pick<
    DeviceCredentialRecord,
    | "credentialKeyId"
    | "upstreamBackendId"
    | "deviceInstanceId"
    | "deviceLabel"
    | "operationFamilies"
  >,
  extra: Record<string, unknown> = {}
) => ({
  credentialKeyId: credential.credentialKeyId,
  upstreamBackendId: credential.upstreamBackendId,
  deviceInstanceId: credential.deviceInstanceId,
  deviceLabel: credential.deviceLabel,
  operationFamilies: credential.operationFamilies,
  ...extra
});

const resolveCredentialOperationFamilies = (
  challengeFamilies: string[],
  requestedFamilies: string[] | undefined
): string[] => {
  const families = requestedFamilies ?? challengeFamilies;
  const allowed = new Set(challengeFamilies);
  const requested = Array.from(new Set(families));
  if (requested.some((family) => !allowed.has(family))) {
    throw Object.assign(
      new Error(
        "Device credential operation families exceed enrollment challenge"
      ),
      { statusCode: 400 }
    );
  }
  return requested;
};

export const createDeviceCredentialRepository = (db: KoedDb) => ({
  async createDeviceEnrollmentChallenge(input: {
    challengeHash: string;
    upstreamBackendId: string;
    deviceInstanceId?: string | null;
    deviceLabel?: string | null;
    requestedOperationFamilies?: string[];
    metadata?: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<DeviceEnrollmentChallengeRecord> {
    const rows = await db
      .insert(deviceEnrollmentChallenges)
      .values({
        challengeHash: input.challengeHash,
        upstreamBackendId: input.upstreamBackendId,
        deviceInstanceId: input.deviceInstanceId ?? null,
        deviceLabel: input.deviceLabel ?? null,
        requestedOperationFamilies: input.requestedOperationFamilies ?? [],
        metadata: input.metadata ?? {},
        expiresAt: input.expiresAt
      })
      .returning();

    return mapChallengeRecord(rows[0]!);
  },

  async redeemDeviceEnrollmentChallenge(
    actor: ActorContext,
    input: {
      challengeHash: string;
      credentialKeyId: string;
      verifierKind: "secret_hash" | "public_key_jwk";
      verifierHash?: string | null;
      publicKeyJwk?: Record<string, unknown> | null;
      operationFamilies?: string[];
      metadata?: Record<string, unknown>;
      expiresAt?: Date | null;
    }
  ): Promise<DeviceCredentialRecord | null> {
    return db.transaction(async (tx) => {
      const challengeRows = await tx
        .update(deviceEnrollmentChallenges)
        .set({
          boundByUserId: actor.userId,
          boundAt: sql`now()`,
          redeemedAt: sql`now()`
        })
        .where(
          and(
            eq(deviceEnrollmentChallenges.challengeHash, input.challengeHash),
            isNull(deviceEnrollmentChallenges.redeemedAt),
            gt(deviceEnrollmentChallenges.expiresAt, sql`now()`)
          )
        )
        .returning();

      const challenge = challengeRows[0];
      if (!challenge) {
        return null;
      }
      const operationFamilies = resolveCredentialOperationFamilies(
        challenge.requestedOperationFamilies,
        input.operationFamilies
      );

      const credentialRows = await tx
        .insert(deviceCredentials)
        .values({
          ownerUserId: actor.userId,
          enrollmentChallengeId: challenge.id,
          credentialKeyId: input.credentialKeyId,
          upstreamBackendId: challenge.upstreamBackendId,
          deviceInstanceId:
            challenge.deviceInstanceId ?? `device-${challenge.id}`,
          deviceLabel: challenge.deviceLabel,
          verifierKind: input.verifierKind,
          verifierHash:
            input.verifierKind === "secret_hash"
              ? (input.verifierHash ?? null)
              : null,
          publicKeyJwk:
            input.verifierKind === "public_key_jwk"
              ? (input.publicKeyJwk ?? null)
              : null,
          operationFamilies,
          metadata: input.metadata ?? challenge.metadata,
          expiresAt: input.expiresAt ?? null
        })
        .returning();

      const credential = mapDeviceCredentialRecord(credentialRows[0]!);
      await tx.insert(auditEvents).values(
        auditEventValues({
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "device_credential.created",
          targetTable: "device_credentials",
          targetId: credential.id,
          metadata: deviceCredentialAuditMetadata(credential, {
            enrollmentChallengeId: credential.enrollmentChallengeId
          })
        })
      );

      return credential;
    });
  },

  async listDeviceCredentials(
    actor: ActorContext,
    input: { upstreamBackendId?: string } = {}
  ): Promise<DeviceCredentialRecord[]> {
    const filters = [
      eq(deviceCredentials.ownerUserId, actor.userId),
      isNull(deviceCredentials.revokedAt)
    ];
    if (input.upstreamBackendId) {
      filters.push(
        eq(deviceCredentials.upstreamBackendId, input.upstreamBackendId)
      );
    }
    const rows = await db
      .select()
      .from(deviceCredentials)
      .where(and(...filters))
      .orderBy(desc(deviceCredentials.createdAt));

    return rows.map(mapDeviceCredentialRecord);
  },

  async revokeDeviceCredential(
    actor: ActorContext,
    credentialId: string,
    reason?: string
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(deviceCredentials)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: actor.userId,
          revocationReason: reason ?? null,
          updatedAt: sql`now()`
        })
        .where(
          and(
            eq(deviceCredentials.id, credentialId),
            eq(deviceCredentials.ownerUserId, actor.userId),
            isNull(deviceCredentials.revokedAt)
          )
        )
        .returning();

      const row = rows[0];
      if (!row) {
        return false;
      }
      const credential = mapDeviceCredentialRecord(row);
      await tx.insert(auditEvents).values(
        auditEventValues({
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "device_credential.revoked",
          targetTable: "device_credentials",
          targetId: credential.id,
          metadata: deviceCredentialAuditMetadata(credential, {
            reason: reason ?? null
          })
        })
      );
      return true;
    });
  },

  async getDeviceCredentialUser(input: {
    credentialKeyId: string;
    verifierHash: string;
  }): Promise<DeviceCredentialAuthContext | null> {
    const updatedRows = await db
      .update(deviceCredentials)
      .set({
        lastUsedAt: sql`now()`,
        lastValidatedAt: sql`now()`,
        updatedAt: sql`now()`
      })
      .where(
        and(
          eq(deviceCredentials.credentialKeyId, input.credentialKeyId),
          eq(deviceCredentials.verifierKind, "secret_hash"),
          eq(deviceCredentials.verifierHash, input.verifierHash),
          isNull(deviceCredentials.revokedAt),
          or(
            isNull(deviceCredentials.expiresAt),
            gt(deviceCredentials.expiresAt, sql`now()`)
          ),
          sql`exists (
            select 1
            from ${users}
            where ${users.id} = ${deviceCredentials.ownerUserId}
              and ${users.disabledAt} is null
              and ${users.deletedAt} is null
          )`
        )
      )
      .returning();

    const credential = updatedRows[0];
    if (!credential) {
      return null;
    }

    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash
      })
      .from(users)
      .where(
        and(
          eq(users.id, credential.ownerUserId),
          isNull(users.disabledAt),
          isNull(users.deletedAt)
        )
      )
      .limit(1);
    const user = userRows[0];
    if (!user) {
      return null;
    }

    return {
      user: mapUserRecord(user) as UserRecord,
      credential: mapDeviceCredentialRecord(credential)
    };
  }
});
