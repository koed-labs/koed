import type pg from "pg";
import {
  repositoryChangeInputSchema,
  repositoryChangeSchema,
  repositoryIdentityMatches,
  type RepositoryChangeInput,
  type RepositoryChange
} from "@koed/shared";

export const repositoryReviewFailure = (
  statusCode: number,
  message: string
): never => {
  throw Object.assign(new Error(message), { statusCode });
};
export type RepositoryChangeRow = {
  id: string;
  kind: "anchor_change" | "capture_conflict";
  originating_device_id: string;
  checkout_id: string;
  revision: number;
  originating_revision: number | null;
  previous_identity: RepositoryChange["previousIdentity"];
  target_identity: RepositoryChange["targetIdentity"];
  status: RepositoryChange["status"];
  created_at: Date;
};
export const mapRepositoryChange = (
  row: RepositoryChangeRow
): RepositoryChange =>
  repositoryChangeSchema.parse({
    id: row.id,
    kind: row.kind,
    originatingDeviceId: row.originating_device_id,
    checkoutId: row.checkout_id,
    revision: row.revision,
    originatingRevision: row.originating_revision,
    previousIdentity: row.previous_identity,
    targetIdentity: row.target_identity,
    status: row.status,
    createdAt: row.created_at.toISOString()
  });
export const lockRepositoryCheckout = async (
  client: pg.PoolClient,
  owner: string,
  device: string,
  checkout: string
): Promise<void> => {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["repository-review", owner, device, checkout])
  ]);
};
const sameAnchor = (
  a: RepositoryChange["targetIdentity"],
  b: RepositoryChange["targetIdentity"]
): boolean =>
  a.kind === "unresolved" && b.kind === "unresolved"
    ? a.reason === b.reason
    : repositoryIdentityMatches(a, b);
export const recordRepositoryChange = async (
  client: pg.PoolClient,
  owner: string,
  raw: RepositoryChangeInput
): Promise<RepositoryChange> => {
  const input = repositoryChangeInputSchema.parse(raw);
  await lockRepositoryCheckout(
    client,
    owner,
    input.originatingDeviceId,
    input.checkoutId
  );
  const existing = await client.query<RepositoryChangeRow>(
    "select * from repository_change_events where id=$1 and owner_user_id=$2",
    [input.id, owner]
  );
  if (existing.rows[0]) {
    const event = mapRepositoryChange(existing.rows[0]);
    if (
      event.checkoutId !== input.checkoutId ||
      event.originatingDeviceId !== input.originatingDeviceId ||
      JSON.stringify(event.targetIdentity) !==
        JSON.stringify(input.targetIdentity)
    )
      repositoryReviewFailure(
        409,
        "Repository change id was reused with different provenance."
      );
    return event;
  }
  const latest = (
    await client.query<RepositoryChangeRow>(
      `select * from repository_change_events where owner_user_id=$1 and originating_device_id=$2 and checkout_id=$3 and status <> 'superseded' order by revision desc limit 1`,
      [owner, input.originatingDeviceId, input.checkoutId]
    )
  ).rows[0];
  if (latest && sameAnchor(latest.target_identity, input.targetIdentity)) {
    if (input.originatingRevision !== null) {
      const advanced = await client.query<RepositoryChangeRow>(
        "update repository_change_events set originating_revision=greatest(coalesce(originating_revision,0),$2) where id=$1 returning *",
        [latest.id, input.originatingRevision]
      );
      return mapRepositoryChange(advanced.rows[0]!);
    }
    return mapRepositoryChange(latest);
  }
  const maximum = (
    await client.query<{
      revision: number | null;
      event_revision: number | null;
    }>(
      `select max(originating_revision) as revision, max(revision) as event_revision from repository_change_events where owner_user_id=$1 and originating_device_id=$2 and checkout_id=$3`,
      [owner, input.originatingDeviceId, input.checkoutId]
    )
  ).rows[0];
  const maxOrigin = maximum?.revision;
  const stale =
    input.originatingRevision !== null &&
    maxOrigin !== null &&
    maxOrigin !== undefined &&
    input.originatingRevision <= maxOrigin;
  if (!stale)
    await client.query(
      `update repository_change_events set status='superseded', completed_at=now() where owner_user_id=$1 and originating_device_id=$2 and checkout_id=$3 and status='pending'`,
      [owner, input.originatingDeviceId, input.checkoutId]
    );
  const result = await client.query<RepositoryChangeRow>(
    `insert into repository_change_events (id,owner_user_id,originating_device_id,checkout_id,revision,originating_revision,kind,previous_identity,target_identity,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [
      input.id,
      owner,
      input.originatingDeviceId,
      input.checkoutId,
      (maximum?.event_revision ?? 0) + 1,
      input.originatingRevision,
      input.kind,
      latest && !stale ? latest.target_identity : input.previousIdentity,
      input.targetIdentity,
      stale ? "superseded" : "pending"
    ]
  );
  return mapRepositoryChange(result.rows[0]!);
};
