import { createHash, randomUUID } from "node:crypto";
import { parseCanonicalPdsJson } from "@koed/shared";
import pg from "pg";

export type PersonalDeviceGroupState =
  | "active"
  | "equivocation_freeze"
  | "quarantine";
export type PersonalDeviceGroupMemberStatus = "active" | "revoked";

export interface PersonalDeviceMemberRecord {
  deviceId: string;
  signingKeyId: string;
  signingPublicKey: string;
  kemKeyId: string;
  kemPublicKey: string;
  operationFamilies: string[];
  status: PersonalDeviceGroupMemberStatus;
  admittedSequence: string;
  revokedSequence: string | null;
  revokedAt: string | null;
}

export interface PersonalDeviceGroupRecord {
  id: string;
  groupId: string;
  authorityKeyId: string;
  authorityPublicKey: string;
  recoverySigningKeyId: string;
  recoverySigningPublicKey: string;
  recoveryKemKeyId: string;
  recoveryKemPublicKey: string;
  currentEpoch: string;
  pendingEpoch: string | null;
  pendingStatementSequence: string | null;
  pendingStatementHash: string | null;
  pendingBundleHash: string | null;
  headSequence: string;
  headHash: string;
  state: PersonalDeviceGroupState;
  stateReason: string | null;
  members: PersonalDeviceMemberRecord[];
  policy: {
    enabled: boolean;
    futureClosedSessionsOnly: true;
    historicalBackfillEnabled: false;
  };
}

export type PdsTransitionResult =
  | { outcome: "accepted"; group: PersonalDeviceGroupRecord; statement: string }
  | {
      outcome: "conflict";
      group: PersonalDeviceGroupRecord;
      statement: string | null;
    }
  | {
      outcome: "equivocation";
      group: PersonalDeviceGroupRecord;
      statement: string | null;
    };

const hashSecret = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const queryRow = <T extends Record<string, unknown>>(value: unknown): T =>
  value as T;
const iso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;
const recordMember = (
  row: Record<string, unknown>
): PersonalDeviceMemberRecord => ({
  deviceId: row.device_id as string,
  signingKeyId: row.signing_key_id as string,
  signingPublicKey: row.signing_public_key as string,
  kemKeyId: row.kem_key_id as string,
  kemPublicKey: row.kem_public_key as string,
  operationFamilies: row.operation_families as string[],
  status: row.status as PersonalDeviceGroupMemberStatus,
  admittedSequence: row.admitted_sequence as string,
  revokedSequence: (row.revoked_sequence as string | null) ?? null,
  revokedAt: iso(row.revoked_at as Date | null)
});

const selectGroup = async (
  client: pg.PoolClient,
  userId: string,
  groupId: string
): Promise<PersonalDeviceGroupRecord | null> => {
  const group = await client.query(
    `select g.*, p.enabled, p.future_closed_sessions_only, p.historical_backfill_enabled
    from personal_device_groups g
    join local_personal_identities i on i.id = g.local_personal_identity_id
    join personal_sync_policies p on p.group_id = g.id
    where g.group_id = $1 and i.owner_user_id = $2`,
    [groupId, userId]
  );
  const row = group.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const members = await client.query(
    "select * from personal_device_group_members where group_id = $1 order by device_id",
    [row.id]
  );
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    authorityKeyId: row.authority_key_id as string,
    authorityPublicKey: row.authority_public_key as string,
    recoverySigningKeyId: row.recovery_signing_key_id as string,
    recoverySigningPublicKey: row.recovery_signing_public_key as string,
    recoveryKemKeyId: row.recovery_kem_key_id as string,
    recoveryKemPublicKey: row.recovery_kem_public_key as string,
    currentEpoch: row.current_epoch as string,
    pendingEpoch: (row.pending_epoch as string | null) ?? null,
    pendingStatementSequence:
      (row.pending_statement_sequence as string | null) ?? null,
    pendingStatementHash: (row.pending_statement_hash as string | null) ?? null,
    pendingBundleHash: (row.pending_bundle_hash as string | null) ?? null,
    headSequence: row.head_sequence as string,
    headHash: row.head_hash as string,
    state: row.state as PersonalDeviceGroupState,
    stateReason: (row.state_reason as string | null) ?? null,
    members: members.rows.map(recordMember),
    policy: {
      enabled: row.enabled as boolean,
      futureClosedSessionsOnly: row.future_closed_sessions_only as true,
      historicalBackfillEnabled: row.historical_backfill_enabled as false
    }
  };
};

const redactedMetadata = (
  draft: Record<string, unknown>
): Record<string, unknown> => ({
  protocol: draft.protocol,
  kind: draft.kind,
  sequence: draft.sequence,
  groupIdHash: hashSecret(String(draft.groupId)),
  actorKeyId:
    (draft.body as Record<string, unknown>)?.deviceSigningKeyId ?? null
});

export const createPersonalDeviceSyncRepository = (pool: pg.Pool) => ({
  async createPersonalDeviceEnrollmentChallenge(input: {
    userId: string;
    groupId?: string | null;
    browserSubjectId: string;
    browserDeploymentId: string;
    challenge: string;
    expiresAt: Date;
  }): Promise<{ id: string; challenge: string; expiresAt: string }> {
    const result = await pool.query(
      `insert into personal_device_enrollment_challenges
        (user_id,group_id,browser_subject_id,browser_deployment_id,challenge_hash,expires_at)
      values ($1,$2,$3,$4,$5,$6) returning id, expires_at`,
      [
        input.userId,
        input.groupId ?? null,
        input.browserSubjectId,
        input.browserDeploymentId,
        hashSecret(input.challenge),
        input.expiresAt
      ]
    );
    const row = queryRow<{ id: string; expires_at: Date }>(result.rows[0]);
    return {
      id: row.id,
      challenge: input.challenge,
      expiresAt: row.expires_at.toISOString()
    };
  },

  async consumePersonalDeviceEnrollmentChallenge(input: {
    userId: string;
    challengeId: string;
    groupId?: string | null;
    browserSubjectId: string;
    browserDeploymentId: string;
    challenge: string;
  }): Promise<boolean> {
    const result = await pool.query(
      `update personal_device_enrollment_challenges set used_at = now()
      where id = $1 and user_id = $2 and challenge_hash = $3 and used_at is null and expires_at > now()
      and (($4::text is null and group_id is null) or group_id = $4)
      and browser_subject_id=$5 and browser_deployment_id=$6`,
      [
        input.challengeId,
        input.userId,
        hashSecret(input.challenge),
        input.groupId ?? null,
        input.browserSubjectId,
        input.browserDeploymentId
      ]
    );
    return result.rowCount === 1;
  },

  async getPersonalDeviceGroup(
    userId: string,
    groupId: string
  ): Promise<PersonalDeviceGroupRecord | null> {
    const client = await pool.connect();
    try {
      return await selectGroup(client, userId, groupId);
    } finally {
      client.release();
    }
  },

  async listPersonalDeviceGroups(
    userId: string
  ): Promise<PersonalDeviceGroupRecord[]> {
    const client = await pool.connect();
    try {
      const groups = await client.query<{ group_id: string }>(
        `select g.group_id from personal_device_groups g
        join local_personal_identities i on i.id = g.local_personal_identity_id
        where i.owner_user_id = $1 order by g.created_at`,
        [userId]
      );
      return (
        await Promise.all(
          groups.rows.map(async (row) =>
            selectGroup(client, userId, row.group_id)
          )
        )
      ).flatMap((group) => (group ? [group] : []));
    } finally {
      client.release();
    }
  },

  async listPersonalDeviceGroupStatements(
    userId: string,
    groupId: string
  ): Promise<
    Array<{
      sequence: string;
      statementHash: string;
      canonicalStatement: string;
    }>
  > {
    const client = await pool.connect();
    try {
      const group = await selectGroup(client, userId, groupId);
      if (!group) return [];
      const rows = await client.query(
        "select sequence, statement_hash, canonical_statement from personal_device_group_statements where group_id = $1 order by sequence",
        [group.id]
      );
      return rows.rows.map((value) => {
        const row = queryRow<{
          sequence: string;
          statement_hash: string;
          canonical_statement: string;
        }>(value);
        return {
          sequence: row.sequence,
          statementHash: row.statement_hash,
          canonicalStatement: row.canonical_statement
        };
      });
    } finally {
      client.release();
    }
  },

  async createPersonalDeviceGroup(input: {
    userId: string;
    groupId: string;
    subjectId: string;
    subjectDeploymentId: string;
    authorityKeyId: string;
    authorityPublicKey: string;
    recoverySigningKeyId: string;
    recoverySigningPublicKey: string;
    recoveryKemKeyId: string;
    recoveryKemPublicKey: string;
    recoveryKitHash: string;
    initialEpoch: string;
    statementHash: string;
    statement: string;
    device: Omit<
      PersonalDeviceMemberRecord,
      "status" | "admittedSequence" | "revokedSequence" | "revokedAt"
    >;
  }): Promise<PersonalDeviceGroupRecord | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const identity = await client.query(
        `insert into local_personal_identities (owner_user_id, opaque_identity_id) values ($1, $2)
        on conflict (owner_user_id) do update set updated_at = now() returning id`,
        [input.userId, randomUUID()]
      );
      const identityId = queryRow<{ id: string }>(identity.rows[0]).id;
      const group = await client.query(
        `insert into personal_device_groups
        (local_personal_identity_id, group_id, authority_key_id, authority_public_key, recovery_signing_key_id, recovery_signing_public_key, recovery_kem_key_id, recovery_kem_public_key, recovery_kit_hash, current_epoch, head_sequence, head_hash)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'1',$11) on conflict (local_personal_identity_id) do nothing returning id`,
        [
          identityId,
          input.groupId,
          input.authorityKeyId,
          input.authorityPublicKey,
          input.recoverySigningKeyId,
          input.recoverySigningPublicKey,
          input.recoveryKemKeyId,
          input.recoveryKemPublicKey,
          input.recoveryKitHash,
          input.initialEpoch,
          input.statementHash
        ]
      );
      if (!group.rowCount) {
        await client.query("rollback");
        return await selectGroup(client, input.userId, input.groupId);
      }
      const groupDbId = queryRow<{ id: string }>(group.rows[0]).id;
      const subject = await client.query(
        "insert into personal_device_group_user_subjects (group_id, user_id, subject_id, deployment_id) values ($1,$2,$3,$4) returning id",
        [groupDbId, input.userId, input.subjectId, input.subjectDeploymentId]
      );
      await client.query(
        `insert into personal_device_group_members (group_id,user_subject_id,device_id,signing_key_id,signing_public_key,kem_key_id,kem_public_key,operation_families,status,admitted_sequence)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'active','1')`,
        [
          groupDbId,
          queryRow<{ id: string }>(subject.rows[0]).id,
          input.device.deviceId,
          input.device.signingKeyId,
          input.device.signingPublicKey,
          input.device.kemKeyId,
          input.device.kemPublicKey,
          input.device.operationFamilies
        ]
      );
      await client.query(
        `insert into personal_device_group_statements (group_id,sequence,previous_hash,statement_hash,kind,canonical_statement,redacted_metadata)
        values ($1,'1',null,$2,'genesis',$3,$4)`,
        [
          groupDbId,
          input.statementHash,
          input.statement,
          {
            protocol: "koed/pds/v1",
            kind: "genesis",
            sequence: "1",
            groupIdHash: hashSecret(input.groupId)
          }
        ]
      );
      await client.query(
        "insert into personal_sync_policies (group_id, enabled, future_closed_sessions_only, historical_backfill_enabled, updated_by_user_id) values ($1,false,true,false,$2)",
        [groupDbId, input.userId]
      );
      await client.query(
        "insert into personal_device_group_audit_events (group_id,transition_kind,actor_key_id,outcome,head_sequence,head_hash) values ($1,'genesis',$2,'accepted','1',$3)",
        [groupDbId, input.device.signingKeyId, input.statementHash]
      );
      await client.query("commit");
      return await selectGroup(client, input.userId, input.groupId);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async commitPersonalDeviceTransition(input: {
    userId: string;
    groupId: string;
    expectedHeadHash: string;
    sequence: string;
    nextEpoch: string | null;
    kind:
      | "add-device"
      | "revoke-device"
      | "recover"
      | "tombstone"
      | "resolve-conflict";
    statementHash: string;
    statement: string;
    authorizationKeyId: string;
    browserSubjectId: string;
    browserDeploymentId: string;
    keyBundle?: {
      hash: string;
      canonical: string;
      epoch: string;
      transitionKind: string;
      recipients: string[];
    };
    addedDevice?: Omit<
      PersonalDeviceMemberRecord,
      "status" | "admittedSequence" | "revokedSequence" | "revokedAt"
    >;
    revokeDeviceIds?: string[];
  }): Promise<PdsTransitionResult | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group) {
        await client.query("rollback");
        return null;
      }
      if (group.state !== "active") {
        await client.query("rollback");
        return { outcome: "equivocation", group, statement: null };
      }
      if (group.pendingEpoch !== null) {
        await client.query("rollback");
        return { outcome: "conflict", group, statement: null };
      }
      if (
        group.headHash !== input.expectedHeadHash ||
        BigInt(group.headSequence) + 1n !== BigInt(input.sequence)
      ) {
        const sameSequence = await client.query(
          "select canonical_statement from personal_device_group_statements where group_id=$1 and sequence=$2",
          [group.id, input.sequence]
        );
        const existingStatement = sameSequence.rowCount
          ? queryRow<{ canonical_statement: string }>(sameSequence.rows[0])
          : null;
        await client.query("rollback");
        return {
          outcome: "conflict",
          group,
          statement: existingStatement?.canonical_statement ?? null
        };
      }
      if (
        ["add-device", "revoke-device", "recover"].includes(input.kind) &&
        !input.keyBundle
      )
        throw Object.assign(
          new Error("PDS membership transition requires key bundle"),
          {
            statusCode: 409
          }
        );
      if (input.keyBundle) {
        let expectedRecipients = group.members
          .filter((member) => member.status === "active")
          .map((member) => member.deviceId);
        if (input.addedDevice)
          expectedRecipients.push(input.addedDevice.deviceId);
        if (input.revokeDeviceIds) {
          expectedRecipients = expectedRecipients.filter(
            (deviceId) => !input.revokeDeviceIds?.includes(deviceId)
          );
        }
        expectedRecipients.push(group.recoveryKemKeyId);
        expectedRecipients = [...new Set(expectedRecipients)].sort();
        if (
          JSON.stringify(expectedRecipients) !==
          JSON.stringify(input.keyBundle.recipients)
        )
          throw Object.assign(
            new Error("PDS key bundle recipient snapshot is incomplete"),
            {
              statusCode: 409
            }
          );
        const existing = await client.query(
          "select canonical_bundle from personal_device_group_key_bundles where group_id=$1 and bundle_hash=$2",
          [group.id, input.keyBundle.hash]
        );
        const existingBundle = existing.rowCount
          ? queryRow<{ canonical_bundle: string }>(existing.rows[0])
          : null;
        if (
          existingBundle &&
          existingBundle.canonical_bundle !== input.keyBundle.canonical
        )
          throw Object.assign(new Error("PDS key bundle equivocation"), {
            statusCode: 409
          });
        if (!existing.rowCount)
          await client.query(
            "insert into personal_device_group_key_bundles (group_id,bundle_hash,epoch,transition_kind,recipient_snapshot,canonical_bundle) values ($1,$2,$3,$4,$5,$6)",
            [
              group.id,
              input.keyBundle.hash,
              input.keyBundle.epoch,
              input.keyBundle.transitionKind,
              input.keyBundle.recipients,
              input.keyBundle.canonical
            ]
          );
      }
      if (input.addedDevice) {
        const added = await client.query(
          `insert into personal_device_group_members (group_id,user_subject_id,device_id,signing_key_id,signing_public_key,kem_key_id,kem_public_key,operation_families,status,admitted_sequence)
          select $1,id,$2,$3,$4,$5,$6,$7,'active',$8 from personal_device_group_user_subjects
          where group_id=$1 and user_id=$9 and subject_id=$10 and deployment_id=$11
            and revoked_at is null`,
          [
            group.id,
            input.addedDevice.deviceId,
            input.addedDevice.signingKeyId,
            input.addedDevice.signingPublicKey,
            input.addedDevice.kemKeyId,
            input.addedDevice.kemPublicKey,
            input.addedDevice.operationFamilies,
            input.sequence,
            input.userId,
            input.browserSubjectId,
            input.browserDeploymentId
          ]
        );
        if (!added.rowCount)
          throw Object.assign(
            new Error("PDS browser subject binding is unavailable"),
            { statusCode: 403 }
          );
      }
      if (input.revokeDeviceIds?.length) {
        const revoked = await client.query(
          "update personal_device_group_members set status='revoked', revoked_sequence=$1, revoked_at=now(), updated_at=now() where group_id=$2 and device_id = any($3::text[]) and status='active'",
          [input.sequence, group.id, input.revokeDeviceIds]
        );
        if (revoked.rowCount !== input.revokeDeviceIds.length)
          throw Object.assign(new Error("PDS device is not active"), {
            statusCode: 409
          });
        await client.query(
          `update personal_device_membership_certificates set revoked_at=now()
          where group_id=$1 and member_id in (select id from personal_device_group_members where group_id=$1 and device_id = any($2::text[])) and revoked_at is null`,
          [group.id, input.revokeDeviceIds]
        );
      }
      const membershipTransition = input.nextEpoch !== null;
      const update = await client.query(
        `update personal_device_groups set head_sequence=$1,head_hash=$2,
          current_epoch=case when $3 then current_epoch else coalesce($4,current_epoch) end,
          pending_epoch=case when $3 then $4 else null end,
          pending_statement_sequence=case when $3 then $1 else null end,
          pending_statement_hash=case when $3 then $2 else null end,
          pending_bundle_hash=case when $3 then $7 else null end,
          updated_at=now() where id=$5 and head_hash=$6 and pending_epoch is null returning id`,
        [
          input.sequence,
          input.statementHash,
          membershipTransition,
          input.nextEpoch,
          group.id,
          input.expectedHeadHash,
          input.keyBundle?.hash ?? null
        ]
      );
      if (!update.rowCount) {
        await client.query("rollback");
        return { outcome: "conflict", group, statement: null };
      }
      const draft = (
        parseCanonicalPdsJson(input.statement) as {
          draft: Record<string, unknown>;
        }
      ).draft;
      await client.query(
        "insert into personal_device_group_statements (group_id,sequence,previous_hash,statement_hash,kind,canonical_statement,redacted_metadata) values ($1,$2,$3,$4,$5,$6,$7)",
        [
          group.id,
          input.sequence,
          input.expectedHeadHash,
          input.statementHash,
          input.kind,
          input.statement,
          redactedMetadata(draft)
        ]
      );
      await client.query(
        "insert into personal_device_group_audit_events (group_id,transition_kind,actor_key_id,outcome,head_sequence,head_hash) values ($1,$2,$3,'accepted',$4,$5)",
        [
          group.id,
          input.kind,
          input.authorizationKeyId,
          input.sequence,
          input.statementHash
        ]
      );
      await client.query("commit");
      return {
        outcome: "accepted",
        group: (await selectGroup(client, input.userId, input.groupId))!,
        statement: input.statement
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async acknowledgePersonalDeviceEpoch(input: {
    userId: string;
    groupId: string;
    deviceId: string;
    epoch: string;
    canonicalAck: string;
    acknowledgedAt: Date;
  }): Promise<{ group: PersonalDeviceGroupRecord; activated: boolean } | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group || group.pendingEpoch !== input.epoch) {
        await client.query("rollback");
        return null;
      }
      const member = await client.query(
        "select id from personal_device_group_members where group_id=$1 and device_id=$2 and status='active'",
        [group.id, input.deviceId]
      );
      if (!member.rowCount)
        throw Object.assign(new Error("PDS member is not active"), {
          statusCode: 409
        });
      await client.query(
        `insert into personal_device_epoch_acks (group_id,member_id,epoch,canonical_ack,acknowledged_at)
        values ($1,$2,$3,$4,$5) on conflict (group_id,member_id,epoch) do nothing`,
        [
          group.id,
          queryRow<{ id: string }>(member.rows[0]).id,
          input.epoch,
          input.canonicalAck,
          input.acknowledgedAt
        ]
      );
      const pending = await client.query(
        `select count(*) filter (where m.status='active')::int as active_count,
          count(a.id) filter (where m.status='active')::int as ack_count
        from personal_device_group_members m left join personal_device_epoch_acks a
          on a.member_id=m.id and a.group_id=m.group_id and a.epoch=$2 where m.group_id=$1`,
        [group.id, input.epoch]
      );
      const counts = queryRow<{ active_count: number; ack_count: number }>(
        pending.rows[0]
      );
      const activated =
        counts.active_count > 0 && counts.active_count === counts.ack_count;
      if (activated)
        await client.query(
          `update personal_device_groups set current_epoch=pending_epoch,pending_epoch=null,pending_statement_sequence=null,pending_statement_hash=null,pending_bundle_hash=null,updated_at=now() where id=$1`,
          [group.id]
        );
      await client.query("commit");
      return {
        group: (await selectGroup(client, input.userId, input.groupId))!,
        activated
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async storePersonalDeviceMembershipCertificate(input: {
    userId: string;
    groupId: string;
    deviceId: string;
    epoch: string;
    statementSequence: string;
    statementHash: string;
    authorityKeyId: string;
    canonicalCertificate: string;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group)
        throw Object.assign(new Error("Personal Device Group not found"), {
          statusCode: 404
        });
      const member = await client.query(
        "select id from personal_device_group_members where group_id=$1 and device_id=$2 and status='active'",
        [group.id, input.deviceId]
      );
      if (!member.rowCount)
        throw Object.assign(new Error("PDS member is not active"), {
          statusCode: 409
        });
      await client.query(
        `insert into personal_device_membership_certificates (group_id,member_id,epoch,statement_sequence,statement_hash,authority_key_id,canonical_certificate,issued_at,expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (group_id,member_id,epoch) do update set canonical_certificate=excluded.canonical_certificate,issued_at=excluded.issued_at,expires_at=excluded.expires_at,revoked_at=null`,
        [
          group.id,
          queryRow<{ id: string }>(member.rows[0]).id,
          input.epoch,
          input.statementSequence,
          input.statementHash,
          input.authorityKeyId,
          input.canonicalCertificate,
          input.issuedAt,
          input.expiresAt
        ]
      );
    } finally {
      client.release();
    }
  },

  async freezePersonalDeviceGovernance(input: {
    userId: string;
    groupId: string;
    reason: string;
    actorKeyId?: string;
  }): Promise<PersonalDeviceGroupRecord | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        input.groupId
      ]);
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group) {
        await client.query("rollback");
        return null;
      }
      if (group.state === "active") {
        await client.query(
          "update personal_device_groups set state='equivocation_freeze',state_reason=$1,updated_at=now() where id=$2",
          [input.reason, group.id]
        );
        await client.query(
          "insert into personal_device_group_audit_events (group_id,transition_kind,actor_key_id,outcome,head_sequence,head_hash) values ($1,'governance',$2,'frozen',$3,$4)",
          [
            group.id,
            input.actorKeyId ?? null,
            group.headSequence,
            group.headHash
          ]
        );
      }
      await client.query("commit");
      return await selectGroup(client, input.userId, input.groupId);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async getPersonalDeviceKeyBundle(input: {
    userId: string;
    groupId: string;
    epoch: string;
  }): Promise<string | null> {
    const client = await pool.connect();
    try {
      const group = await selectGroup(client, input.userId, input.groupId);
      if (
        !group ||
        (group.currentEpoch !== input.epoch &&
          group.pendingEpoch !== input.epoch) ||
        !group.members.some((member) => member.status === "active")
      )
        return null;
      const result = await client.query(
        "select canonical_bundle from personal_device_group_key_bundles where group_id=$1 and epoch=$2",
        [group.id, input.epoch]
      );
      return result.rowCount
        ? queryRow<{ canonical_bundle: string }>(result.rows[0])
            .canonical_bundle
        : null;
    } finally {
      client.release();
    }
  },

  async getPersonalDeviceMembershipCertificate(input: {
    userId: string;
    groupId: string;
    deviceId: string;
  }): Promise<string | null> {
    const client = await pool.connect();
    try {
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group || group.pendingEpoch !== null) return null;
      const result = await client.query(
        `select c.canonical_certificate from personal_device_membership_certificates c
        join personal_device_group_members m on m.id=c.member_id
        where c.group_id=$1 and c.epoch=$2 and m.device_id=$3 and m.status='active'
          and c.revoked_at is null and c.expires_at>now()`,
        [group.id, group.currentEpoch, input.deviceId]
      );
      return result.rowCount
        ? queryRow<{ canonical_certificate: string }>(result.rows[0])
            .canonical_certificate
        : null;
    } finally {
      client.release();
    }
  },

  async updatePersonalSyncPolicy(
    userId: string,
    groupId: string,
    enabled: boolean
  ): Promise<PersonalDeviceGroupRecord | null> {
    const client = await pool.connect();
    try {
      const group = await selectGroup(client, userId, groupId);
      if (!group) return null;
      await client.query(
        "update personal_sync_policies set enabled=$1, updated_by_user_id=$2, updated_at=now() where group_id=$3",
        [enabled, userId, group.id]
      );
      return await selectGroup(client, userId, groupId);
    } finally {
      client.release();
    }
  },

  async createRemoteAccountLink(input: {
    userId: string;
    groupId: string;
    remoteIssuer: string;
    remoteDeploymentId: string;
    remoteSubjectId: string;
    nonce: string;
    expiresAt: Date;
  }): Promise<{
    id: string;
    remoteDeploymentId: string;
    remoteSubjectId: string;
    syncEnabled: false;
  } | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await selectGroup(client, input.userId, input.groupId);
      if (!group) {
        await client.query("rollback");
        return null;
      }
      const nonce = await client.query(
        `insert into personal_device_remote_link_nonces (group_id,issuer_deployment_id,nonce_hash,expires_at,consumed_at)
        values ($1,$2,$3,$4,now()) on conflict (issuer_deployment_id,nonce_hash) do nothing returning id`,
        [
          group.id,
          `${input.remoteIssuer}\0${input.remoteDeploymentId}`,
          hashSecret(input.nonce),
          input.expiresAt
        ]
      );
      const nonceHash = hashSecret(input.nonce);
      if (!nonce.rowCount) {
        const existing = await client.query(
          `select l.id,l.remote_deployment_id,l.remote_subject_id from remote_account_links l
          join personal_device_groups g on g.local_personal_identity_id=l.local_personal_identity_id
          where g.id=$1 and l.remote_issuer=$2 and l.remote_deployment_id=$3
            and l.remote_subject_id=$4 and l.proof_nonce_hash=$5`,
          [
            group.id,
            input.remoteIssuer,
            input.remoteDeploymentId,
            input.remoteSubjectId,
            nonceHash
          ]
        );
        if (!existing.rowCount) {
          await client.query("rollback");
          throw Object.assign(
            new Error("Remote Account Link proof nonce was already consumed"),
            { statusCode: 409 }
          );
        }
        await client.query("commit");
        const linked = queryRow<{
          id: string;
          remote_deployment_id: string;
          remote_subject_id: string;
        }>(existing.rows[0]);
        return {
          id: linked.id,
          remoteDeploymentId: linked.remote_deployment_id,
          remoteSubjectId: linked.remote_subject_id,
          syncEnabled: false
        };
      }
      const row = await client.query(
        `insert into remote_account_links
          (local_personal_identity_id,remote_issuer,remote_deployment_id,remote_subject_id,proof_nonce_hash,proof_expires_at,sync_enabled)
        select local_personal_identity_id,$1,$2,$3,$4,$5,false from personal_device_groups where id=$6
        on conflict (local_personal_identity_id,remote_deployment_id,remote_subject_id)
        do update set remote_issuer=excluded.remote_issuer,proof_nonce_hash=excluded.proof_nonce_hash,
          proof_expires_at=excluded.proof_expires_at,updated_at=now()
        returning id,remote_deployment_id,remote_subject_id`,
        [
          input.remoteIssuer,
          input.remoteDeploymentId,
          input.remoteSubjectId,
          nonceHash,
          input.expiresAt,
          group.id
        ]
      );
      const linked = queryRow<{
        id: string;
        remote_deployment_id: string;
        remote_subject_id: string;
      }>(row.rows[0]);
      await client.query("commit");
      return {
        id: linked.id,
        remoteDeploymentId: linked.remote_deployment_id,
        remoteSubjectId: linked.remote_subject_id,
        syncEnabled: false
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

export type PersonalDeviceSyncRepository = ReturnType<
  typeof createPersonalDeviceSyncRepository
>;
