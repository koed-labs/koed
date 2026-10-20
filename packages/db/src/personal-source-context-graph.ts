import type pg from "pg";
import {
  personalGitContextRevisionSchema,
  personalFolderContextRevisionSchema,
  type PersonalGitAssignment,
  type PersonalFolderAssignment
} from "@koed/shared";

type Assignment = PersonalGitAssignment | PersonalFolderAssignment;
export type SourceContextRevision<T = Assignment> = {
  revisionId: string;
  replaces: string[];
  assignment: T;
};
/** Edges alone establish causality. Counter values and delivery times do not select a head. */
export const evaluateSourceContextFrontier = <T>(
  records: readonly SourceContextRevision<T>[]
): {
  state: "pending" | "conflict" | "available";
  frontier: string[];
  assignment: T | null;
} => {
  const byId = new Map<string, SourceContextRevision<T>>();
  for (const revision of records) {
    if (byId.has(revision.revisionId))
      throw new Error("Source context contains duplicate revisions");
    if (
      new Set(revision.replaces).size !== revision.replaces.length ||
      revision.replaces.includes(revision.revisionId)
    )
      throw new Error("Source context has an invalid reviewed frontier");
    byId.set(revision.revisionId, revision);
  }
  const children = new Map<string, string[]>(),
    remaining = new Map<string, number>();
  let missing = false;
  for (const revision of records) {
    remaining.set(
      revision.revisionId,
      revision.replaces.filter((parent) => byId.has(parent)).length
    );
    for (const parent of revision.replaces) {
      if (!byId.has(parent)) missing = true;
      children.set(parent, [
        ...(children.get(parent) ?? []),
        revision.revisionId
      ]);
    }
  }
  const frontier = [...byId.keys()].filter((id) => !children.has(id)).sort();
  const queue = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    visited++;
    for (const child of children.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  // An incomplete chain remains pending. A closed cycle cannot be accepted as a resolution.
  if (visited !== byId.size) throw new Error("Source context contains a cycle");
  if (missing || !frontier.length)
    return { state: "pending", frontier, assignment: null };
  if (frontier.length !== 1)
    return { state: "conflict", frontier, assignment: null };
  return {
    state: "available",
    frontier,
    assignment: byId.get(frontier[0]!)!.assignment
  };
};

/** A revision ID is immutable within its source and axis, including after replay or reset. */
export const retainSourceContextRevision = async (
  client: pg.PoolClient,
  input: {
    bindingId: string;
    axis: "git" | "folder";
    revision: SourceContextRevision;
    witnessDeviceId?: string;
    retainedPackageId?: string;
    verifiedRecordHash?: string;
    localChangeRevisionId?: string;
  }
) => {
  const revision = (
    input.axis === "git"
      ? personalGitContextRevisionSchema
      : personalFolderContextRevisionSchema
  ).parse(input.revision);
  if (
    new Set(revision.replaces).size !== revision.replaces.length ||
    revision.replaces.includes(revision.revisionId) ||
    (revision.assignment.correction.state === "corrected" &&
      revision.assignment.correction.revisionId !== revision.revisionId)
  )
    throw new TypeError("PdsCryptoSourceContextFrontierError");
  const bound = await client.query<{
    owner_user_id: string;
    original: unknown;
  }>(
    `select owner_user_id,case when $2='git' then git_original else folder_original end as original from personal_source_bindings where binding_id=$1`,
    [input.bindingId, input.axis]
  );
  const binding = bound.rows[0];
  if (!binding) throw new TypeError("PdsCryptoSourceBindingIdentityError");
  if (binding.original !== null) {
    const same = await client.query(
      `select 1 from personal_source_bindings where binding_id=$1 and (case when $2='git' then git_original else folder_original end)=$3::jsonb`,
      [input.bindingId, input.axis, revision.assignment.original]
    );
    if (!same.rowCount)
      throw new TypeError("PdsCryptoSourceOriginalProvenanceChangedError");
  }
  if (input.axis === "folder") {
    const folder =
      personalFolderContextRevisionSchema.parse(revision).assignment;
    for (const fact of [
      folder.original,
      ...(folder.correction.state === "corrected"
        ? [folder.correction.value]
        : [])
    ])
      if (
        fact.state === "known" &&
        fact.value.reference.ownerUserId !== binding.owner_user_id
      )
        throw new TypeError("PdsCryptoSourceContextOwnerError");
  }
  const replaces = [...revision.replaces].sort();
  const inserted = await client.query(
    `insert into personal_source_context_revisions(binding_id,axis,revision_id,replaces,assignment,witness_device_id,retained_package_id,verified_record_hash,local_change_revision_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(binding_id,axis,revision_id) do nothing returning revision_id`,
    [
      input.bindingId,
      input.axis,
      revision.revisionId,
      replaces,
      revision.assignment,
      input.witnessDeviceId ?? null,
      input.retainedPackageId ?? null,
      input.verifiedRecordHash ?? null,
      input.localChangeRevisionId ?? null
    ]
  );
  if (!inserted.rowCount) {
    const same = await client.query(
      "select 1 from personal_source_context_revisions where binding_id=$1 and axis=$2 and revision_id=$3 and replaces=$4::text[] and assignment=$5::jsonb",
      [
        input.bindingId,
        input.axis,
        revision.revisionId,
        replaces,
        revision.assignment
      ]
    );
    if (!same.rowCount)
      throw new TypeError("PdsCryptoSourceContextRevisionEquivocationError");
  }
};
export const loadSourceContextFrontier = async (
  client: pg.PoolClient,
  bindingId: string,
  axis: "git" | "folder"
) => {
  const result = await client.query<{
    revision_id: string;
    replaces: string[];
    assignment: unknown;
  }>(
    "select revision_id,replaces,assignment from personal_source_context_revisions where binding_id=$1 and axis=$2 order by revision_id",
    [bindingId, axis]
  );
  const schema =
    axis === "git"
      ? personalGitContextRevisionSchema
      : personalFolderContextRevisionSchema;
  const records = result.rows.map((row) =>
    schema.parse({
      revisionId: row.revision_id,
      replaces: row.replaces,
      assignment: row.assignment
    })
  );
  return evaluateSourceContextFrontier<Assignment>(records);
};
