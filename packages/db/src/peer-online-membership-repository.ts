import type pg from "pg";
import { reconcilePeerOnlineDeletionRecipients } from "./peer-online-deletion-roster.js";
import { assertPeerOnlineNotQuarantined } from "./peer-online-restore-quarantine.js";
import {
  cancellablePeerOnlineTransaction,
  throwIfPeerOnlineAborted
} from "./peer-online-cancellable-transaction.js";
import {
  applyPeerMembership,
  canonicalizePdsJson,
  initializePeerMembership,
  inspectPeerMembership,
  type PeerMembershipAnchor,
  type PeerMembershipMember,
  type PeerMembershipState
} from "@koed/shared";

type Group = {
  anchor_matches: boolean;
  record_count: number;
  conflict: boolean;
  incomplete: boolean;
  limit_size: number | null;
};
type Evidence = { position: number; hash: string; json: string };

export type PeerAdmissionAttempt = {
  attemptId: string;
  expectedHead: string;
  approverDeviceId: string;
  target: PeerMembershipMember;
  expiresAt: Date;
};

declare const verifiedTranscript: unique symbol;
/** Internal trust boundary only: no verifier or pairing protocol exists here.
 * A future reviewed verifier must bind every field and transcriptHash to its
 * authenticated ceremony. Type branding is not runtime authentication. */
export type VerifiedPeerAdmissionAuthorization = PeerAdmissionAttempt & {
  groupId: string;
  transcriptHash: string;
  readonly [verifiedTranscript]: true;
};

type AttemptRow = {
  expected_head: string;
  approver_device_id: string;
  target_json: string;
  expires_at: Date;
  valid_now: boolean;
  transcript_hash: string | null;
  outcome_hash: string | null;
  outcome_json: string | null;
};

export async function transaction<T>(
  pool: pg.Pool,
  groupId: string,
  run: (client: pg.PoolClient) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal)
    return cancellablePeerOnlineTransaction(pool, groupId, run, signal);
  const client = await pool.connect();
  try {
    await client.query("begin isolation level read committed");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`koed:peer-online-membership:${groupId}`]
    );
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function replay(
  client: pg.PoolClient,
  anchor: PeerMembershipAnchor,
  signal?: AbortSignal
): Promise<PeerMembershipState> {
  const { groupId } = anchor;
  throwIfPeerOnlineAborted(signal);
  const group = (
    await client.query<Group>(
      `select genesis_hash = $2 as anchor_matches, record_count, conflict, incomplete,
              octet_length(limit_evidence) as limit_size
       from peer_online_membership_groups where group_id = $1 for update`,
      [groupId, anchor.genesisHash]
    )
  ).rows[0];
  throwIfPeerOnlineAborted(signal);
  if (!group) throw new Error("peer membership group not found");
  if (!group.anchor_matches) throw new Error("peer membership anchor mismatch");
  const corrupt = () => {
    throw new Error("corrupt peer membership evidence");
  };
  const bounds = () => {
    throw new Error("peer membership storage bounds exceeded");
  };
  // Keep these bounds aligned with the shared validator; never fetch unbounded payloads.
  if (
    group.record_count < 1 ||
    group.record_count > 1024 ||
    (group.limit_size !== null && group.limit_size > 16384)
  )
    return bounds();
  const metadata = (
    await client.query<{
      position: number;
      hash_size: number;
      json_size: number;
    }>(
      `select position, octet_length(hash) as hash_size, octet_length(json) as json_size
     from peer_online_membership_evidence where group_id = $1 order by position limit 1025`,
      [groupId]
    )
  ).rows;
  throwIfPeerOnlineAborted(signal);
  if (
    metadata.length !== group.record_count ||
    metadata.some((row, i) => row.position !== i)
  )
    return corrupt();
  if (metadata.some((row) => row.hash_size > 43 || row.json_size > 16384))
    return bounds();
  const rows = (
    await client.query<Evidence>(
      `select position, case when octet_length(hash) <= 43 then hash end as hash,
            case when octet_length(json) <= 16384 then json end as json
     from peer_online_membership_evidence where group_id = $1 order by position limit 1025`,
      [groupId]
    )
  ).rows;
  throwIfPeerOnlineAborted(signal);
  if (rows.some((row) => row.hash === null || row.json === null))
    return bounds();
  if (
    !rows.length ||
    rows.length !== group.record_count ||
    rows.some((row, i) => row.position !== i)
  )
    return corrupt();
  const init = initializePeerMembership(anchor, rows[0]!.json);
  if (init.status !== "accepted" || rows[0]!.hash !== anchor.genesisHash)
    return corrupt();
  let state = init.state;
  for (const row of rows.slice(1)) {
    throwIfPeerOnlineAborted(signal);
    const result = applyPeerMembership(state, row.json);
    if (result.status !== "accepted") return corrupt();
    state = result.state;
    if (inspectPeerMembership(state).records.at(-1)?.hash !== row.hash)
      return corrupt();
  }
  if (group.limit_size !== null) {
    const limit = (
      await client.query<{ evidence: string | null }>(
        `select case when octet_length(limit_evidence) <= 16384 then limit_evidence end as evidence
       from peer_online_membership_groups where group_id = $1`,
        [groupId]
      )
    ).rows[0]?.evidence;
    throwIfPeerOnlineAborted(signal);
    if (limit == null) return bounds();
    const result = applyPeerMembership(state, limit);
    if (
      result.status !== "limit" ||
      !inspectPeerMembership(result.state).incomplete
    )
      return corrupt();
    state = result.state;
  }
  const view = inspectPeerMembership(state);
  if (view.conflict !== group.conflict || view.incomplete !== group.incomplete)
    return corrupt();
  throwIfPeerOnlineAborted(signal);
  return state;
}

/**
 * Anchors must come from independently trusted storage. Replay detects inconsistent
 * corruption, not restoration of a consistent older database: authorization needs
 * an independently protected checkpoint or peer reconciliation for rollback safety.
 * Pending input is not retained. After an authenticated limit, the validator cannot
 * authenticate or retain later evidence, including forks or revocations; even the
 * first limit evidence may conceal a fork. Callers must keep that state fail closed.
 * Database writes must be restricted to cooperating repository users. Replay is
 * CPU-intensive; callers must rate-limit untrusted requests. Admission is an
 * internal persistence primitive, not a pairing verifier or network endpoint.
 * The branded authorization is a compile-time boundary only; it must be produced
 * by a future reviewed verifier, never deserialized from untrusted input. Retry
 * outcomes report historical success, not current membership authorization.
 * Expired unused attempts are cleaned in bounded batches. Consumed receipts are
 * retained indefinitely and count toward the 1024-per-group cap; exhaustion
 * requires a future safe recovery design. Rollback-resistant storage is absent.
 */
export function createPeerOnlineMembershipRepository(pool: pg.Pool) {
  return {
    async initialize(anchor: PeerMembershipAnchor, json: string) {
      const result = initializePeerMembership(anchor, json);
      if (result.status !== "accepted") return result;
      return transaction(pool, anchor.groupId, async (client) => {
        const existing = await client.query<{ anchor_matches: boolean }>(
          "select genesis_hash = $2 as anchor_matches from peer_online_membership_groups where group_id = $1",
          [anchor.groupId, anchor.genesisHash]
        );
        if (existing.rows.length) {
          if (!existing.rows[0]!.anchor_matches)
            return { status: "invalid" as const, reason: "anchor mismatch" };
          await replay(client, anchor);
          await assertPeerOnlineNotQuarantined(client, anchor);
          return { status: "duplicate" as const };
        }
        await client.query(
          "insert into peer_online_membership_groups (group_id, genesis_hash, record_count, conflict, incomplete) values ($1,$2,1,false,false)",
          [anchor.groupId, anchor.genesisHash]
        );
        await client.query(
          "insert into peer_online_membership_evidence (group_id, position, hash, json) values ($1,0,$2,$3)",
          [anchor.groupId, anchor.genesisHash, json]
        );
        return { status: "accepted" as const };
      });
    },
    async append(anchor: PeerMembershipAnchor, json: string) {
      const { groupId } = anchor;
      return transaction(pool, groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const result = applyPeerMembership(state, json);
        const view = inspectPeerMembership(result.state);
        if (result.status === "accepted") {
          const record = view.records.at(-1)!;
          await client.query(
            "insert into peer_online_membership_evidence (group_id, position, hash, json) values ($1,$2,$3,$4)",
            [groupId, view.records.length - 1, record.hash, record.json]
          );
        }
        if (
          result.status === "accepted" ||
          (result.status === "limit" &&
            view.incomplete &&
            !inspectPeerMembership(state).incomplete)
        ) {
          await client.query(
            "update peer_online_membership_groups set record_count=$2, conflict=$3, incomplete=$4, limit_evidence=$5 where group_id=$1",
            [
              groupId,
              view.records.length,
              view.conflict,
              view.incomplete,
              view.limitEvidence ?? null
            ]
          );
        }
        if (result.status === "accepted")
          await reconcilePeerOnlineDeletionRecipients(
            client,
            groupId,
            result.state
          );
        if (result.status === "pending")
          return { status: result.status, missingParent: result.missingParent };
        if (result.status === "invalid" || result.status === "limit")
          return { status: result.status, reason: result.reason };
        return { status: result.status };
      });
    },
    async createAdmissionAttempt(
      anchor: PeerMembershipAnchor,
      attempt: PeerAdmissionAttempt
    ) {
      const targetJson = canonicalizePdsJson(attempt.target);
      if (
        !attempt.attemptId ||
        attempt.attemptId.length > 240 ||
        !Number.isFinite(attempt.expiresAt.getTime()) ||
        Buffer.byteLength(targetJson) > 16384
      )
        throw new Error("invalid admission attempt");
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const view = inspectPeerMembership(state);
        if (
          view.head !== attempt.expectedHead ||
          !view.members.some((m) => m.deviceId === attempt.approverDeviceId)
        )
          throw new Error("invalid admission authority or head");
        const expiry = await client.query<{ valid: boolean }>(
          "select $1::timestamptz > clock_timestamp() and $1::timestamptz <= clock_timestamp() + interval '15 minutes' as valid",
          [attempt.expiresAt]
        );
        if (!expiry.rows[0]!.valid) throw new Error("invalid admission expiry");
        await client.query(
          `delete from peer_online_admission_attempts where ctid in
           (select ctid from peer_online_admission_attempts where group_id=$1 and outcome_hash is null and expires_at <= clock_timestamp() limit 128)`,
          [anchor.groupId]
        );
        const count = await client.query<{ count: string }>(
          "select count(*)::text as count from peer_online_admission_attempts where group_id=$1",
          [anchor.groupId]
        );
        // Consumed outcomes cannot be deleted without permitting token reuse.
        if (Number(count.rows[0]!.count) >= 1024)
          throw new Error("admission attempt limit reached");
        const inserted = await client.query(
          `insert into peer_online_admission_attempts (group_id, attempt_id, expected_head, approver_device_id, target_json, expires_at)
           select $1,$2,$3,$4,$5,$6 where $6::timestamptz > clock_timestamp() and $6::timestamptz <= clock_timestamp() + interval '15 minutes'`,
          [
            anchor.groupId,
            attempt.attemptId,
            attempt.expectedHead,
            attempt.approverDeviceId,
            targetJson,
            attempt.expiresAt
          ]
        );
        if (inserted.rowCount !== 1)
          throw new Error("invalid admission expiry");
      });
    },
    async admit(
      anchor: PeerMembershipAnchor,
      authorization: VerifiedPeerAdmissionAuthorization,
      json: string
    ) {
      return transaction(pool, anchor.groupId, async (client) => {
        const state = await replay(client, anchor);
        await assertPeerOnlineNotQuarantined(client, anchor);
        const row = (
          await client.query<AttemptRow>(
            `select *, expires_at > clock_timestamp() as valid_now from peer_online_admission_attempts where group_id=$1 and attempt_id=$2 for update`,
            [anchor.groupId, authorization.attemptId]
          )
        ).rows[0];
        if (
          !row ||
          authorization.groupId !== anchor.groupId ||
          !authorization.transcriptHash ||
          authorization.transcriptHash.length > 240 ||
          row.expected_head !== authorization.expectedHead ||
          row.approver_device_id !== authorization.approverDeviceId ||
          row.target_json !== canonicalizePdsJson(authorization.target) ||
          row.expires_at.getTime() !== authorization.expiresAt.getTime()
        )
          throw new Error("invalid admission authorization");
        if (row.outcome_hash !== null) {
          if (
            row.transcript_hash !== authorization.transcriptHash ||
            row.outcome_json !== json
          )
            throw new Error("admission attempt already consumed");
          return {
            status: "historical_receipt" as const,
            hash: row.outcome_hash
          };
        }
        const view = inspectPeerMembership(state);
        if (
          !row.valid_now ||
          view.head !== row.expected_head ||
          !view.members.some((m) => m.deviceId === row.approver_device_id)
        )
          throw new Error("expired or stale admission attempt");
        const result = applyPeerMembership(state, json);
        const next = inspectPeerMembership(result.state);
        const authenticatedLimit =
          result.status === "limit" && next.incomplete && !view.incomplete;
        if (result.status !== "accepted" && !authenticatedLimit)
          throw new Error("invalid admission evidence");
        const parsed = JSON.parse(json) as {
          unsigned: {
            parentHash: string;
            authorDeviceId: string;
            body: { kind: string; target: PeerMembershipMember };
          };
        };
        if (
          parsed.unsigned.parentHash !== row.expected_head ||
          parsed.unsigned.authorDeviceId !== row.approver_device_id ||
          parsed.unsigned.body.kind !== "add" ||
          canonicalizePdsJson(parsed.unsigned.body.target) !== row.target_json
        )
          throw new Error("admission evidence does not match authorization");
        if (authenticatedLimit) {
          const persisted = await client.query(
            `update peer_online_membership_groups set incomplete=true, limit_evidence=$3
             where group_id=$1 and exists (select 1 from peer_online_admission_attempts
               where group_id=$1 and attempt_id=$2 and outcome_hash is null and expires_at > clock_timestamp())`,
            [anchor.groupId, authorization.attemptId, next.limitEvidence]
          );
          if (persisted.rowCount !== 1)
            throw new Error("expired or stale admission attempt");
          return { status: "limit" as const };
        }
        const evidence = next.records.at(-1)!;
        if (next.head !== evidence.hash)
          throw new Error("invalid admission evidence");
        await client.query(
          "insert into peer_online_membership_evidence (group_id, position, hash, json) values ($1,$2,$3,$4)",
          [
            anchor.groupId,
            next.records.length - 1,
            evidence.hash,
            evidence.json
          ]
        );
        await client.query(
          "update peer_online_membership_groups set record_count=$2, conflict=$3, incomplete=$4 where group_id=$1",
          [anchor.groupId, next.records.length, next.conflict, next.incomplete]
        );
        const consumed = await client.query(
          "update peer_online_admission_attempts set transcript_hash=$3, outcome_hash=$4, outcome_json=$5 where group_id=$1 and attempt_id=$2 and expires_at > clock_timestamp() and outcome_hash is null",
          [
            anchor.groupId,
            authorization.attemptId,
            authorization.transcriptHash,
            evidence.hash,
            evidence.json
          ]
        );
        if (consumed.rowCount !== 1)
          throw new Error("expired or stale admission attempt");
        await reconcilePeerOnlineDeletionRecipients(
          client,
          anchor.groupId,
          result.state
        );
        return { status: "historical_receipt" as const, hash: evidence.hash };
      });
    },
    async load(anchor: PeerMembershipAnchor) {
      return transaction(pool, anchor.groupId, async (client) =>
        inspectPeerMembership(await replay(client, anchor))
      );
    }
  };
}
