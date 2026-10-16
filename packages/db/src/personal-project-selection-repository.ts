import type pg from "pg";
import {
  canonicalizePdsJson,
  pdsProjectSelectionRecordSchema,
  resolvePdsProjectSelection,
  requireReviewedProjectSelectionHeads,
  type PdsProjectSelectionRecord,
  type PdsProjectSelectionState
} from "@koed/shared";

type Scope = {
  userId: string;
  groupId: string;
  associationId: string;
  selectionId: string;
};

/** All mutations serialize with association discovery and group lifecycle changes. */
const ownedGroup = async (
  client: pg.PoolClient,
  scope: Pick<Scope, "userId" | "groupId">
): Promise<string> => {
  const result = await client.query<{ id: string }>(
    `select g.id from personal_device_groups g
     join local_personal_identities i on i.id=g.local_personal_identity_id
     where g.group_id=$1 and i.owner_user_id=$2 and g.state='active'
     for update of g`,
    [scope.groupId, scope.userId]
  );
  if (!result.rows[0]) throw new Error("Personal Device Group is unavailable");
  return result.rows[0].id;
};

const association = async (
  client: pg.PoolClient,
  group: string,
  scope: Scope
): Promise<string> => {
  await client.query(
    `insert into pds_project_associations (group_id,association_id,selection_id)
     values ($1,$2,$3) on conflict (group_id,association_id) do nothing`,
    [group, scope.associationId, scope.selectionId]
  );
  const result = await client.query<{ id: string; selection_id: string }>(
    "select id,selection_id from pds_project_associations where group_id=$1 and association_id=$2 for update",
    [group, scope.associationId]
  );
  if (result.rows[0]?.selection_id !== scope.selectionId)
    throw new Error("Project association selection identity differs");
  return result.rows[0].id;
};

const readState = async (
  client: pg.PoolClient,
  id: string,
  scope: Scope
): Promise<PdsProjectSelectionState> => {
  const result = await client.query<{
    signed_record: PdsProjectSelectionRecord;
  }>(
    "select signed_record from pds_project_selection_revisions where association_row_id=$1",
    [id]
  );
  return resolvePdsProjectSelection(
    scope,
    result.rows.map(
      (row) => pdsProjectSelectionRecordSchema.parse(row.signed_record).revision
    )
  );
};

/** Transport authentication must verify author certificates and signatures first.
 * No import accepts a checkout or establishes local acceptance of an association.
 */
export const createPersonalProjectSelectionRepository = (pool: pg.Pool) => ({
  async refreshRecipients(input: {
    userId: string;
    groupId: string;
    epoch: string;
    authorDeviceId: string;
  }): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, input);
      const refreshed = await client.query(
        `update pds_project_selection_outbox o set state='pending',attempt_count=0,
         retry_at=now(),transport_id=null,dispatch_epoch=$2,lease_owner=null,lease_until=null
         from pds_project_selection_revisions r,personal_device_groups g
         where r.id=o.revision_row_id and r.group_id=$1 and g.id=r.group_id
         and g.current_epoch=$2 and r.signed_record->'revision'->>'authorDeviceId'=$3
         and o.dispatch_epoch is distinct from $2
         and (o.lease_until is null or o.lease_until<=now())`,
        [group, input.epoch, input.authorDeviceId]
      );
      if (refreshed.rowCount)
        await client.query(
          "select pg_notify('koed_pds_local_sync','project_selection_recipients_changed')"
        );
      await client.query("commit");
      return refreshed.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async accept(
    input: Scope & {
      originatingDeviceId: string;
      checkoutId: string;
      localProjectId: string;
    }
  ): Promise<PdsProjectSelectionState> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, input);
      const found = await client.query<{ id: string; selection_id: string }>(
        "select id,selection_id from pds_project_associations where group_id=$1 and association_id=$2 for update",
        [group, input.associationId]
      );
      if (!found.rows[0] || found.rows[0].selection_id !== input.selectionId)
        throw new Error("Project association is unavailable");
      await client.query(
        `insert into pds_project_association_acceptances (owner_user_id,association_row_id,originating_device_id,checkout_id,local_project_id)
        values ($1,$2,$3,$4,$5) on conflict (owner_user_id,originating_device_id,checkout_id)
        do update set association_row_id=excluded.association_row_id,local_project_id=excluded.local_project_id,accepted_at=now()`,
        [
          input.userId,
          found.rows[0].id,
          input.originatingDeviceId,
          input.checkoutId,
          input.localProjectId
        ]
      );
      const state = await readState(client, found.rows[0].id, input);
      await client.query("commit");
      return state;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async forgetAcceptance(input: {
    userId: string;
    originatingDeviceId: string;
    checkoutId: string;
  }): Promise<void> {
    await pool.query(
      "delete from pds_project_association_acceptances where owner_user_id=$1 and originating_device_id=$2 and checkout_id=$3",
      [input.userId, input.originatingDeviceId, input.checkoutId]
    );
  },

  async readAccepted(input: {
    userId: string;
    originatingDeviceId: string;
    checkoutId: string;
  }): Promise<{
    groupId: string;
    associationId: string;
    selectionId: string;
    state: PdsProjectSelectionState;
  } | null> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{
        id: string;
        group_id: string;
        association_id: string;
        selection_id: string;
      }>(
        `select a.id,g.group_id,a.association_id,a.selection_id from pds_project_association_acceptances c
         join pds_project_associations a on a.id=c.association_row_id
         join personal_device_groups g on g.id=a.group_id
         join local_personal_identities i on i.id=g.local_personal_identity_id
         where c.owner_user_id=$1 and i.owner_user_id=$1 and c.originating_device_id=$2 and c.checkout_id=$3`,
        [input.userId, input.originatingDeviceId, input.checkoutId]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("commit");
        return null;
      }
      const scope = {
        userId: input.userId,
        groupId: row.group_id,
        associationId: row.association_id,
        selectionId: row.selection_id
      };
      await ownedGroup(client, scope);
      const state = await readState(client, row.id, scope);
      await client.query("commit");
      return {
        groupId: scope.groupId,
        associationId: scope.associationId,
        selectionId: scope.selectionId,
        state
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async listAssociations(input: { userId: string; groupId: string }): Promise<
    Array<{
      associationId: string;
      selectionId: string;
      state: PdsProjectSelectionState;
    }>
  > {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, input);
      const rows = await client.query<{
        id: string;
        association_id: string;
        selection_id: string;
      }>(
        "select id,association_id,selection_id from pds_project_associations where group_id=$1 order by association_id",
        [group]
      );
      const results = [];
      for (const row of rows.rows) {
        const scope = {
          ...input,
          associationId: row.association_id,
          selectionId: row.selection_id
        };
        results.push({
          associationId: scope.associationId,
          selectionId: scope.selectionId,
          state: await readState(client, row.id, scope)
        });
      }
      await client.query("commit");
      return results;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async claimDelivery(input: {
    userId: string;
    groupId: string;
    workerId: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      state: "pending" | "committed";
      record: PdsProjectSelectionRecord;
      transportId: string | null;
      attemptCount: number;
    }>
  > {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, input);
      const result = await client.query<{
        id: string;
        state: "pending" | "committed";
        signed_record: PdsProjectSelectionRecord;
        transport_id: string | null;
        attempt_count: number;
      }>(
        `with due as (
          select o.id from pds_project_selection_outbox o
          join pds_project_selection_revisions r on r.id=o.revision_row_id
          join personal_sync_policies p on p.group_id=r.group_id
          where r.group_id=$1 and o.state in ('pending','committed') and o.retry_at<=now()
          and (o.lease_until is null or o.lease_until<now())
          and p.enabled=true and p.publication_paused=false
          order by o.retry_at,o.id for update of o,p skip locked limit $3
        ), claimed as (
          update pds_project_selection_outbox o set lease_owner=$2,
            lease_until=now()+interval '5 minutes',attempt_count=attempt_count+1
          where o.id in (select id from due) returning o.*
        ) select c.id,c.state,c.transport_id,c.attempt_count,r.signed_record
          from claimed c join pds_project_selection_revisions r on r.id=c.revision_row_id`,
        [group, input.workerId, Math.max(1, Math.min(10, input.limit ?? 10))]
      );
      await client.query("commit");
      return result.rows.map((row) => ({
        id: row.id,
        state: row.state,
        record: pdsProjectSelectionRecordSchema.parse(row.signed_record),
        transportId: row.transport_id,
        attemptCount: row.attempt_count
      }));
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async beginDelivery(input: {
    userId: string;
    groupId: string;
    workerId: string;
    outboxId: string;
    expectedEpoch?: string;
  }): Promise<boolean> {
    const result = await pool.query(
      `select 1 from pds_project_selection_outbox o
       join pds_project_selection_revisions r on r.id=o.revision_row_id
       join personal_device_groups g on g.id=r.group_id
       join local_personal_identities i on i.id=g.local_personal_identity_id
       join personal_sync_policies p on p.group_id=g.id
       where o.id=$1 and o.lease_owner=$2 and o.lease_until>now()
       and i.owner_user_id=$3 and g.group_id=$4 and g.state='active'
       and ($5::text is null or g.current_epoch=$5)
       and p.enabled=true and p.publication_paused=false`,
      [
        input.outboxId,
        input.workerId,
        input.userId,
        input.groupId,
        input.expectedEpoch ?? null
      ]
    );
    return !!result.rowCount;
  },

  async settleDelivery(input: {
    workerId: string;
    outboxId: string;
    state: "pending" | "committed" | "acked";
    transportId?: string;
    retryAt?: Date;
  }): Promise<boolean> {
    const result = await pool.query(
      `update pds_project_selection_outbox set state=$3,transport_id=$4,retry_at=$5,
       lease_owner=null,lease_until=null where id=$1 and lease_owner=$2 and lease_until>now()`,
      [
        input.outboxId,
        input.workerId,
        input.state,
        input.transportId ?? null,
        input.retryAt ?? new Date()
      ]
    );
    return !!result.rowCount;
  },
  async read(input: Scope): Promise<PdsProjectSelectionState> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, input);
      const row = await client.query<{ id: string; selection_id: string }>(
        "select id,selection_id from pds_project_associations where group_id=$1 and association_id=$2",
        [group, input.associationId]
      );
      if (row.rows[0] && row.rows[0].selection_id !== input.selectionId)
        throw new Error("Project association selection identity differs");
      const state = row.rows[0]
        ? await readState(client, row.rows[0].id, input)
        : resolvePdsProjectSelection(input, []);
      await client.query("commit");
      return state;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async appendVerified(input: {
    userId: string;
    record: PdsProjectSelectionRecord;
    /** Required for local authoring/resolution, omitted only for verified incoming delivery. */
    reviewedHeads?: string[];
  }): Promise<{ inserted: boolean; state: PdsProjectSelectionState }> {
    const record = pdsProjectSelectionRecordSchema.parse(input.record);
    const scope = { userId: input.userId, ...record.revision };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const group = await ownedGroup(client, scope);
      const id = await association(client, group, scope);
      const previous = await client.query<{
        signed_record: PdsProjectSelectionRecord;
        association_row_id: string;
      }>(
        "select signed_record,association_row_id from pds_project_selection_revisions where group_id=$1 and revision_id=$2",
        [group, record.revision.revisionId]
      );
      if (previous.rows[0]) {
        if (
          previous.rows[0].association_row_id !== id ||
          canonicalizePdsJson(previous.rows[0].signed_record) !==
            canonicalizePdsJson(record)
        )
          throw new Error("Project selection revision was reused");
        const state = await readState(client, id, scope);
        await client.query("commit");
        return { inserted: false, state };
      }
      if (input.reviewedHeads !== undefined) {
        const heads = requireReviewedProjectSelectionHeads(
          await readState(client, id, scope),
          input.reviewedHeads
        );
        if (
          canonicalizePdsJson([...record.revision.replaces].sort()) !==
          canonicalizePdsJson(heads)
        )
          throw new Error(
            "Project selection must replace every reviewed revision"
          );
      }
      // A referenced revision cannot cross association boundaries, in either arrival order.
      const crossed = await client.query(
        `select 1 from pds_project_selection_revisions where group_id=$1 and association_row_id<>$2
         and (revision_id=any($3::text[]) or (signed_record->'revision'->'replaces') ? $4) limit 1`,
        [group, id, record.revision.replaces, record.revision.revisionId]
      );
      if (crossed.rowCount)
        throw new Error(
          "Project selection parent belongs to another association"
        );
      const inserted = await client.query<{ id: string }>(
        "insert into pds_project_selection_revisions (association_row_id,group_id,revision_id,signed_record) values ($1,$2,$3,$4) returning id",
        [id, group, record.revision.revisionId, record]
      );
      const state = await readState(client, id, scope);
      if (input.reviewedHeads !== undefined) {
        await client.query(
          "insert into pds_project_selection_outbox (revision_row_id) values ($1)",
          [inserted.rows[0]!.id]
        );
        await client.query(
          "select pg_notify('koed_pds_local_sync','project_selection_changed')"
        );
      }
      await client.query("commit");
      return { inserted: true, state };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

export type PersonalProjectSelectionRepository = ReturnType<
  typeof createPersonalProjectSelectionRepository
>;
