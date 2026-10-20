import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectCapabilityError
} from "./project-api-repository.js";

type Backend = { backendId: string; relationshipIds: string[] };
type NoteSource = {
  kind: "personal_note";
  noteId: string;
  noteRevision: number;
  memoryEventId: string;
  logicalMemoryId: string;
  backends: Backend[];
};
type BackendAck = {
  logicalMemoryId: string;
  backendId: string;
  generation: number;
  holdVersion: number;
  sealed: boolean;
  cancelled?: boolean;
};
type GrantAck = {
  logicalMemoryId: string;
  backendId: string;
  shareGrantId: string;
  reviewedGrantVersion: number;
  grantVersion: number;
  state: "reserved" | "review_required" | "frozen" | "resolved";
  actionGrantId: string | null;
  commandRequestId: string;
};
export type ProjectSourceRemoveOperation = {
  sourceRemoval: true;
  batchId: string;
  projectId: string;
  sourceId: string;
  ownerUserId: string;
  sources: NoteSource[];
  backendAcks: BackendAck[];
  grantFreezeAcks: GrantAck[];
  state: string;
  sourceManifestHash: string;
};
type Row = Record<string, unknown>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const map = (row: Row): ProjectSourceRemoveOperation => ({
  sourceRemoval: true,
  batchId: String(row.batch_id),
  projectId: String(row.project_id),
  sourceId: String(row.source_id),
  ownerUserId: String(row.owner_user_id),
  sources: row.source_manifest as NoteSource[],
  backendAcks: row.backend_acks as BackendAck[],
  grantFreezeAcks: row.grant_freeze_acks as GrantAck[],
  state: String(row.state),
  sourceManifestHash: String(row.source_manifest_hash)
});

export const createProjectSourceRemovalRepository = (
  pool: pg.Pool,
  configuredBackendIds: () => string[] = () => []
) => {
  const tx = async <T>(
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const lockSource = async (
    client: pg.PoolClient,
    ownerUserId: string,
    projectId: string,
    sourceId: string
  ) => {
    const project = await client.query<Row>(
      `select * from projects where id=$1 and owner_user_id=$2 for update`,
      [projectId, ownerUserId]
    );
    if (!project.rows[0]) throw new ProjectNotFoundError("Project not found");
    if (
      project.rows[0].lifecycle !== "active" ||
      project.rows[0].deletion_phase != null
    )
      throw new ProjectConflictError("Project is unavailable during deletion");
    if (
      project.rows[0].team_backend_id != null ||
      project.rows[0].workspace_project_id != null ||
      project.rows[0].team_workspace_id != null
    )
      throw new ProjectCapabilityError(
        "Linked Project sources require Team authority"
      );
    const source = await client.query<Row>(
      `select * from project_sources where id=$1 and project_id=$2 and owner_user_id=$3 for update`,
      [sourceId, projectId, ownerUserId]
    );
    if (!source.rows[0] || source.rows[0].deleted_at != null)
      throw new ProjectNotFoundError("Project Source not found");
    return source.rows[0];
  };
  const manifest = async (
    client: pg.PoolClient,
    ownerUserId: string,
    sourceId: string
  ): Promise<NoteSource[]> => {
    const notes = await client.query<{
      note_id: string;
      revision: number;
      memory_event_id: string;
      logical_memory_id: string;
      relationship_id: string | null;
      backend_id: string | null;
    }>(
      `select note.note_id,note.revision,note.memory_event_id,root.logical_memory_id,
              relation.id as relationship_id,deployment.upstream_backend_id as backend_id
         from (select distinct on (revision.note_id) revision.note_id,revision.revision,revision.memory_event_id
                 from project_source_revisions attempt
                 join personal_note_revisions revision on revision.id=attempt.note_revision_id
                   and revision.owner_user_id=attempt.owner_user_id
                where attempt.owner_user_id=$1 and attempt.source_id=$2
                  and revision.memory_event_id is not null
                order by revision.note_id,revision.revision desc) note
         join local_personal_note_logical_memories root on root.local_note_id=note.note_id
           and root.owner_user_id=$1
         left join cross_identity_sync_relationships relation on relation.logical_memory_id=root.logical_memory_id
           and relation.local_user_id=$1 and relation.side='source'
         left join deployment_identities deployment on deployment.id=relation.remote_deployment_identity_id
        order by note.note_id,relation.id`,
      [ownerUserId, sourceId]
    );
    const history = await client.query<{ backend_id: string }>(
      `select distinct backend_id from collaboration_shared_memory_enrollments
        where local_owner_user_id=$1 order by backend_id`,
      [ownerUserId]
    );
    const allBackends = [
      ...new Set([
        ...configuredBackendIds(),
        ...history.rows.map((row) => row.backend_id)
      ])
    ];
    const grouped = new Map<string, NoteSource>();
    for (const row of notes.rows) {
      if (row.relationship_id && !row.backend_id)
        throw new ProjectCapabilityError(
          "A Project source backend has no verified identity"
        );
      let item = grouped.get(row.note_id);
      if (!item) {
        item = {
          kind: "personal_note",
          noteId: row.note_id,
          noteRevision: row.revision,
          memoryEventId: row.memory_event_id,
          logicalMemoryId: row.logical_memory_id,
          backends: allBackends.map((backendId) => ({
            backendId,
            relationshipIds: []
          }))
        };
        grouped.set(row.note_id, item);
      }
      if (row.relationship_id && row.backend_id) {
        let backend = item.backends.find(
          (value) => value.backendId === row.backend_id
        );
        if (!backend) {
          backend = { backendId: row.backend_id, relationshipIds: [] };
          item.backends.push(backend);
        }
        backend.relationshipIds.push(row.relationship_id);
      }
    }
    return [...grouped.values()].map((item) => ({
      ...item,
      backends: item.backends.sort((a, b) =>
        a.backendId.localeCompare(b.backendId)
      )
    }));
  };
  const operation = async (
    client: pg.PoolClient,
    ownerUserId: string,
    projectId: string,
    batchId: string,
    lock = true
  ) => {
    const found = await client.query<Row>(
      `select * from project_source_remove_operations where owner_user_id=$1 and project_id=$2 and batch_id=$3 ${lock ? "for update" : ""}`,
      [ownerUserId, projectId, batchId]
    );
    if (!found.rows[0])
      throw new ProjectConflictError(
        "Project Source removal operation changed"
      );
    return map(found.rows[0]);
  };
  return {
    async begin(ownerUserId: string, projectId: string, sourceId: string) {
      return tx(async (client) => {
        const source = await lockSource(
          client,
          ownerUserId,
          projectId,
          sourceId
        );
        if (source.pending_revision_id != null)
          throw new ProjectConflictError(
            "Project Source extraction must finish before removal"
          );
        if (source.remove_batch_id != null) {
          if (typeof source.remove_batch_id !== "string")
            throw new ProjectConflictError(
              "Project Source removal reservation changed"
            );
          return operation(
            client,
            ownerUserId,
            projectId,
            source.remove_batch_id
          );
        }
        const sources = await manifest(client, ownerUserId, sourceId);
        const batchId = randomUUID();
        await client.query(
          `insert into project_source_remove_operations
             (batch_id,owner_user_id,project_id,source_id,source_manifest,source_manifest_hash)
           values($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            batchId,
            ownerUserId,
            projectId,
            sourceId,
            JSON.stringify(sources),
            hash(sources)
          ]
        );
        await client.query(
          `update project_sources set remove_batch_id=$2,updated_at=now() where id=$1`,
          [sourceId, batchId]
        );
        return operation(client, ownerUserId, projectId, batchId);
      });
    },
    async get(ownerUserId: string, projectId: string, batchId: string) {
      return tx((client) =>
        operation(client, ownerUserId, projectId, batchId, false)
      );
    },
    async latest(ownerUserId: string, projectId: string, sourceId: string) {
      const result = await pool.query<Row>(
        `select * from project_source_remove_operations
          where owner_user_id=$1 and project_id=$2 and source_id=$3
          order by created_at desc,batch_id desc limit 1`,
        [ownerUserId, projectId, sourceId]
      );
      return result.rows[0] ? map(result.rows[0]) : null;
    },
    async recordBackendAck(
      ownerUserId: string,
      projectId: string,
      batchId: string,
      ack: BackendAck
    ) {
      return tx(async (client) => {
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (
          !["preparing", "freezing", "cancel_requested"].includes(current.state)
        )
          throw new ProjectConflictError(
            "Project Source removal operation changed"
          );
        if (
          !current.sources.some(
            (source) =>
              source.logicalMemoryId === ack.logicalMemoryId &&
              source.backends.some(
                (backend) => backend.backendId === ack.backendId
              )
          )
        )
          throw new ProjectConflictError(
            "Backend is outside Project Source removal manifest"
          );
        const acks = current.backendAcks.filter(
          (item) =>
            item.logicalMemoryId !== ack.logicalMemoryId ||
            item.backendId !== ack.backendId
        );
        acks.push(ack);
        await client.query(
          `update project_source_remove_operations set backend_acks=$2::jsonb,updated_at=now() where batch_id=$1`,
          [batchId, JSON.stringify(acks)]
        );
      });
    },
    async reserveGrantFreezeReview(
      ownerUserId: string,
      projectId: string,
      batchId: string,
      grant: Pick<
        GrantAck,
        | "logicalMemoryId"
        | "backendId"
        | "shareGrantId"
        | "reviewedGrantVersion"
      >
    ): Promise<GrantAck> {
      return tx(async (client) => {
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (!["preparing", "freezing"].includes(current.state))
          throw new ProjectConflictError(
            "Project Source removal operation changed"
          );
        if (
          !current.sources.some(
            (source) =>
              source.logicalMemoryId === grant.logicalMemoryId &&
              source.backends.some(
                (backend) => backend.backendId === grant.backendId
              )
          )
        )
          throw new ProjectConflictError(
            "Grant is outside Project Source removal manifest"
          );
        const old = current.grantFreezeAcks.find(
          (item) =>
            item.backendId === grant.backendId &&
            item.shareGrantId === grant.shareGrantId
        );
        if (old && old.reviewedGrantVersion === grant.reviewedGrantVersion)
          return old;
        if (old && old.reviewedGrantVersion > grant.reviewedGrantVersion)
          throw new ProjectConflictError("Grant review version changed");
        const reserved: GrantAck = {
          ...grant,
          grantVersion: grant.reviewedGrantVersion,
          state: "reserved",
          actionGrantId: null,
          commandRequestId: randomUUID()
        };
        const acks = current.grantFreezeAcks.filter(
          (item) =>
            item.backendId !== grant.backendId ||
            item.shareGrantId !== grant.shareGrantId
        );
        acks.push(reserved);
        await client.query(
          `update project_source_remove_operations set grant_freeze_acks=$2::jsonb,state='freezing',updated_at=now() where batch_id=$1`,
          [batchId, JSON.stringify(acks)]
        );
        return reserved;
      });
    },
    async recordGrantFreezeAck(
      ownerUserId: string,
      projectId: string,
      batchId: string,
      ack: GrantAck
    ) {
      return tx(async (client) => {
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (!["preparing", "freezing"].includes(current.state))
          throw new ProjectConflictError(
            "Project Source removal operation changed"
          );
        const old = current.grantFreezeAcks.find(
          (item) =>
            item.backendId === ack.backendId &&
            item.shareGrantId === ack.shareGrantId
        );
        if (
          !old ||
          old.commandRequestId !== ack.commandRequestId ||
          old.reviewedGrantVersion !== ack.reviewedGrantVersion ||
          (old.actionGrantId && old.actionGrantId !== ack.actionGrantId)
        )
          throw new ProjectConflictError("Grant review reservation changed");
        if (old.state === "frozen") return old;
        const acks = current.grantFreezeAcks.filter(
          (item) =>
            item.backendId !== ack.backendId ||
            item.shareGrantId !== ack.shareGrantId
        );
        acks.push({
          ...ack,
          actionGrantId: old.actionGrantId ?? ack.actionGrantId
        });
        await client.query(
          `update project_source_remove_operations set grant_freeze_acks=$2::jsonb,state='freezing',updated_at=now() where batch_id=$1`,
          [batchId, JSON.stringify(acks)]
        );
        return ack;
      });
    },
    async complete(
      ownerUserId: string,
      projectId: string,
      sourceId: string,
      batchId: string
    ) {
      return tx(async (client) => {
        const source = await lockSource(
          client,
          ownerUserId,
          projectId,
          sourceId
        );
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (!["preparing", "freezing", "ready"].includes(current.state))
          throw new ProjectConflictError(
            "Project Source removal is being cancelled"
          );
        if (
          current.sourceId !== sourceId ||
          source.remove_batch_id !== batchId ||
          source.pending_revision_id != null
        )
          throw new ProjectConflictError(
            "Project Source removal reservation changed"
          );
        const actual = await manifest(client, ownerUserId, sourceId);
        if (hash(actual) !== current.sourceManifestHash)
          throw new ProjectConflictError(
            "Project Source removal manifest changed"
          );
        if (
          current.sources.some((item) =>
            item.backends.some(
              (backend) =>
                !current.backendAcks.some(
                  (ack) =>
                    ack.logicalMemoryId === item.logicalMemoryId &&
                    ack.backendId === backend.backendId &&
                    ack.sealed
                )
            )
          )
        )
          throw new ProjectConflictError(
            "Remote source acknowledgments are incomplete"
          );
        if (
          current.grantFreezeAcks.some(
            (ack) => ack.state !== "frozen" && ack.state !== "resolved"
          )
        )
          throw new ProjectConflictError(
            "Share Grant freeze reviews are incomplete"
          );
        const updated = await client.query<Row>(
          `update project_sources set deleted_at=now(),remove_batch_id=null,updated_at=now()
            where id=$1 and owner_user_id=$2 returning *`,
          [sourceId, ownerUserId]
        );
        await client.query(
          `update project_source_remove_operations set state='complete',updated_at=now() where batch_id=$1`,
          [batchId]
        );
        return updated.rows[0]!;
      });
    },
    async requestCancel(
      ownerUserId: string,
      projectId: string,
      sourceId: string,
      batchId: string
    ) {
      return tx(async (client) => {
        const source = await lockSource(
          client,
          ownerUserId,
          projectId,
          sourceId
        );
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (current.sourceId !== sourceId || source.remove_batch_id !== batchId)
          throw new ProjectConflictError(
            "Project Source removal reservation changed"
          );
        if (
          !["preparing", "freezing", "cancel_requested"].includes(current.state)
        )
          throw new ProjectConflictError(
            "Project Source removal cancellation changed"
          );
        await client.query(
          `update project_source_remove_operations set state='cancel_requested',updated_at=now() where batch_id=$1`,
          [batchId]
        );
      });
    },
    async cancel(
      ownerUserId: string,
      projectId: string,
      sourceId: string,
      batchId: string
    ) {
      return tx(async (client) => {
        const source = await lockSource(
          client,
          ownerUserId,
          projectId,
          sourceId
        );
        const current = await operation(
          client,
          ownerUserId,
          projectId,
          batchId
        );
        if (current.sourceId !== sourceId || source.remove_batch_id !== batchId)
          throw new ProjectConflictError(
            "Project Source removal reservation changed"
          );
        if (current.state !== "cancel_requested")
          throw new ProjectConflictError(
            "Project Source removal cancellation changed"
          );
        if (
          current.sources.some((item) =>
            item.backends.some(
              (backend) =>
                !current.backendAcks.some(
                  (ack) =>
                    ack.logicalMemoryId === item.logicalMemoryId &&
                    ack.backendId === backend.backendId &&
                    ack.cancelled === true
                )
            )
          )
        )
          throw new ProjectConflictError(
            "Remote source release acknowledgments are incomplete"
          );
        await client.query(
          `update project_source_remove_operations set state='cancelled',updated_at=now() where batch_id=$1`,
          [batchId]
        );
        await client.query(
          `update project_sources set remove_batch_id=null,updated_at=now() where id=$1`,
          [sourceId]
        );
        return current;
      });
    }
  };
};
export type ProjectSourceRemovalRepository = ReturnType<
  typeof createProjectSourceRemovalRepository
>;
