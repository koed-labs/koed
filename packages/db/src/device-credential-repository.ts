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

const validateCredentialKeyId = (value: string): string => {
  const credentialKeyId = value.trim();
  if (!/^[a-z0-9_.-]{16,160}$/i.test(credentialKeyId)) {
    throw Object.assign(new Error("Device credential key id is invalid"), {
      statusCode: 400
    });
  }
  return credentialKeyId;
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

  async getDeviceEnrollmentChallenge(
    challengeId: string
  ): Promise<DeviceEnrollmentChallengeRecord | null> {
    const rows = await db
      .select()
      .from(deviceEnrollmentChallenges)
      .where(eq(deviceEnrollmentChallenges.id, challengeId))
      .limit(1);

    return rows[0] ? mapChallengeRecord(rows[0]) : null;
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
      const credentialKeyId = validateCredentialKeyId(input.credentialKeyId);
      const deviceInstanceId =
        challenge.deviceInstanceId ?? `device-${challenge.id}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${challenge.upstreamBackendId}:${deviceInstanceId}`}, 0))`
      );
      const supersededRows = await tx
        .update(deviceCredentials)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: actor.userId,
          revocationReason: "superseded_by_device_enrollment",
          updatedAt: sql`now()`
        })
        .where(
          and(
            eq(deviceCredentials.ownerUserId, actor.userId),
            eq(
              deviceCredentials.upstreamBackendId,
              challenge.upstreamBackendId
            ),
            eq(deviceCredentials.deviceInstanceId, deviceInstanceId),
            isNull(deviceCredentials.revokedAt)
          )
        )
        .returning();

      const credentialRows = await tx
        .insert(deviceCredentials)
        .values({
          ownerUserId: actor.userId,
          enrollmentChallengeId: challenge.id,
          credentialKeyId,
          upstreamBackendId: challenge.upstreamBackendId,
          deviceInstanceId,
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
      if (supersededRows.length > 0) {
        await tx.insert(auditEvents).values(
          supersededRows.map((row) => {
            const superseded = mapDeviceCredentialRecord(row);
            return auditEventValues({
              actorUserId: actor.userId,
              ownerUserId: actor.userId,
              visibility: "personal",
              action: "device_credential.revoked",
              targetTable: "device_credentials",
              targetId: superseded.id,
              metadata: deviceCredentialAuditMetadata(superseded, {
                reason: "superseded_by_device_enrollment",
                supersededByCredentialId: credential.id
              })
            });
          })
        );
      }
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

  async approveDeviceEnrollmentChallenge(
    actor: ActorContext,
    challengeId: string,
    input: {
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
            eq(deviceEnrollmentChallenges.id, challengeId),
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
      const credentialKeyId = validateCredentialKeyId(input.credentialKeyId);
      const deviceInstanceId =
        challenge.deviceInstanceId ?? `device-${challenge.id}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${challenge.upstreamBackendId}:${deviceInstanceId}`}, 0))`
      );
      const supersededRows = await tx
        .update(deviceCredentials)
        .set({
          revokedAt: sql`now()`,
          revokedByUserId: actor.userId,
          revocationReason: "superseded_by_device_enrollment",
          updatedAt: sql`now()`
        })
        .where(
          and(
            eq(deviceCredentials.ownerUserId, actor.userId),
            eq(
              deviceCredentials.upstreamBackendId,
              challenge.upstreamBackendId
            ),
            eq(deviceCredentials.deviceInstanceId, deviceInstanceId),
            isNull(deviceCredentials.revokedAt)
          )
        )
        .returning();

      const credentialRows = await tx
        .insert(deviceCredentials)
        .values({
          ownerUserId: actor.userId,
          enrollmentChallengeId: challenge.id,
          credentialKeyId,
          upstreamBackendId: challenge.upstreamBackendId,
          deviceInstanceId,
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
          metadata: input.metadata ?? {},
          expiresAt: input.expiresAt ?? null
        })
        .returning();

      const credential = mapDeviceCredentialRecord(credentialRows[0]!);
      if (supersededRows.length > 0) {
        await tx.insert(auditEvents).values(
          supersededRows.map((row) => {
            const superseded = mapDeviceCredentialRecord(row);
            return auditEventValues({
              actorUserId: actor.userId,
              ownerUserId: actor.userId,
              visibility: "personal",
              action: "device_credential.revoked",
              targetTable: "device_credentials",
              targetId: superseded.id,
              metadata: deviceCredentialAuditMetadata(superseded, {
                reason: "superseded_by_device_enrollment",
                supersededByCredentialId: credential.id
              })
            });
          })
        );
      }
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

  async denyDeviceEnrollmentChallenge(
    actor: ActorContext,
    challengeId: string
  ): Promise<DeviceEnrollmentChallengeRecord | null> {
    return db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(deviceEnrollmentChallenges)
        .where(
          and(
            eq(deviceEnrollmentChallenges.id, challengeId),
            isNull(deviceEnrollmentChallenges.redeemedAt),
            gt(deviceEnrollmentChallenges.expiresAt, sql`now()`)
          )
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        return null;
      }

      const rows = await tx
        .update(deviceEnrollmentChallenges)
        .set({
          boundByUserId: actor.userId,
          boundAt: sql`now()`,
          redeemedAt: sql`now()`,
          metadata: {
            ...existing.metadata,
            enrollmentDecision: "denied"
          }
        })
        .where(
          and(
            eq(deviceEnrollmentChallenges.id, challengeId),
            isNull(deviceEnrollmentChallenges.redeemedAt)
          )
        )
        .returning();
      const challenge = rows[0];
      if (!challenge) {
        return null;
      }
      await tx.insert(auditEvents).values(
        auditEventValues({
          actorUserId: actor.userId,
          ownerUserId: actor.userId,
          visibility: "personal",
          action: "device_enrollment.denied",
          targetTable: "device_enrollment_challenges",
          targetId: challenge.id,
          metadata: {
            upstreamBackendId: challenge.upstreamBackendId,
            deviceInstanceId: challenge.deviceInstanceId,
            deviceLabel: challenge.deviceLabel,
            operationFamilies: challenge.requestedOperationFamilies
          }
        })
      );
      return mapChallengeRecord(challenge);
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
