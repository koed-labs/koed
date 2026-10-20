import type pg from "pg";
import {
  personalMembershipEntitySnapshotSchema,
  personalMembershipRevisionSchema,
  personalMembershipReviewPreviewSchema,
  evaluatePersonalMembershipRevisions,
  personalMembershipSelectorKey,
  personalMembershipSourceFromSelectorKey,
  personalMembershipRuleScopeFromSelectorKey,
  personalOwnerIdSchema,
  personalIdentifierSchema,
  decodePdsBase64url,
  type PersonalMembershipEntitySnapshot,
  type PersonalMembershipRevision,
  type PersonalMembershipEntityKind
} from "@koed/shared";

export type PersonalMembershipEntityRow = {
  owner_user_id: string;
  project_identity: string;
  entity_identity: string;
  entity_kind: PersonalMembershipEntityKind;
  local_project_id: string | null;
  local_entity_id: string | null;
  source_binding_id: string | null;
  selector_key: string | null;
  state: "pending" | "available" | "conflict";
  heads: string[];
  current_revision: PersonalMembershipRevision | null;
};
const translateOperationOwner = (
  operation: PersonalMembershipRevision["operation"],
  ownerUserId: string
): PersonalMembershipRevision["operation"] => {
  if (operation.kind === "exclude")
    return { ...operation, source: { ...operation.source, ownerUserId } };
  if (operation.kind !== "include") return operation;
  const selector = operation.selector;
  return {
    ...operation,
    selector:
      selector.kind === "session"
        ? { ...selector, source: { ...selector.source, ownerUserId } }
        : selector.kind === "folder"
          ? { ...selector, folder: { ...selector.folder, ownerUserId } }
          : selector
  };
};
/** Owner aliases are translated only after the enclosing Personal group has been authenticated. */
export const translatePersonalMembershipSnapshotOwner = (
  raw: unknown,
  rawOwnerUserId: string
): PersonalMembershipEntitySnapshot => {
  const snapshot = personalMembershipEntitySnapshotSchema.parse(raw),
    ownerUserId = personalOwnerIdSchema.parse(rawOwnerUserId);
  return personalMembershipEntitySnapshotSchema.parse({
    ...snapshot,
    project: { ...snapshot.project, ownerUserId },
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      project: { ...revision.project, ownerUserId },
      operation: translateOperationOwner(revision.operation, ownerUserId)
    }))
  });
};
const selectorKeyFor = (
  snapshot: PersonalMembershipEntitySnapshot
): string | null => {
  for (const revision of snapshot.revisions) {
    const operation = revision.operation;
    if (operation.kind === "include")
      return personalMembershipSelectorKey(operation.selector);
    if (operation.kind === "exclude")
      return personalMembershipSelectorKey({
        kind: "session",
        source: operation.source
      });
  }
  return null;
};

/** The caller holds the owner journal lock and has checked current signed witness authority.
 * This stores causal truth only; native materialization and review use the returned frontier.
 */
const retainMembershipSnapshot = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    snapshot: PersonalMembershipEntitySnapshot;
    witnessDeviceId: string;
    verifiedRecordHash: string | null;
    nativeChanges?: ReadonlyMap<string, string>;
    localReviews?: ReadonlyMap<string, string>;
  }
) => {
  personalIdentifierSchema.parse(input.witnessDeviceId);
  if (input.verifiedRecordHash !== null)
    decodePdsBase64url(input.verifiedRecordHash, 32);
  const snapshot = translatePersonalMembershipSnapshotOwner(
      input.snapshot,
      input.ownerUserId
    ),
    selectorKey = selectorKeyFor(snapshot);
  const scope = [
    input.ownerUserId,
    snapshot.project.projectId,
    snapshot.entityId
  ];
  await client.query(
    `insert into personal_membership_entities(owner_user_id,project_identity,entity_identity,entity_kind,selector_key)
     values($1,$2,$3,$4,$5) on conflict(owner_user_id,project_identity,entity_identity) do nothing`,
    [...scope, snapshot.entityKind, selectorKey]
  );
  const found = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 for update",
    scope
  );
  const previous = found.rows[0]!;
  if (
    previous.entity_kind !== snapshot.entityKind ||
    previous.selector_key !== selectorKey
  )
    throw new TypeError("PdsCryptoMembershipEntityIdentityError");
  for (const value of snapshot.revisions) {
    const revision = personalMembershipRevisionSchema.parse({
      ...value,
      replaces: [...value.replaces].sort()
    });
    const inserted = await client.query(
      `insert into personal_membership_revisions(owner_user_id,project_identity,entity_identity,revision_id,replaces,revision,witness_device_id,verified_record_hash,native_change_revision_id,local_review_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(owner_user_id,project_identity,entity_identity,revision_id) do nothing returning revision_id`,
      [
        ...scope,
        revision.revisionId,
        revision.replaces,
        revision,
        input.witnessDeviceId,
        input.verifiedRecordHash,
        input.nativeChanges?.get(revision.revisionId) ?? null,
        input.localReviews?.get(revision.revisionId) ?? null
      ]
    );
    if (!inserted.rowCount) {
      const same = await client.query(
        "select 1 from personal_membership_revisions where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 and revision_id=$4 and replaces=$5::text[] and revision=$6::jsonb",
        [...scope, revision.revisionId, revision.replaces, revision]
      );
      if (!same.rowCount)
        throw new TypeError("PdsCryptoMembershipRevisionEquivocationError");
    }
  }
  const records = await client.query<{ revision: PersonalMembershipRevision }>(
    "select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 order by revision_id",
    scope
  );
  const frontier = evaluatePersonalMembershipRevisions(
    records.rows.map((row) => row.revision)
  );
  const updated = await client.query<PersonalMembershipEntityRow>(
    `update personal_membership_entities set state=$4,heads=$5,current_revision=$6,updated_at=now()
     where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 returning *`,
    [...scope, frontier.state, frontier.heads, frontier.revision]
  );
  return {
    previous,
    entity: updated.rows[0]!,
    changed:
      previous.state !== frontier.state ||
      JSON.stringify(previous.heads) !== JSON.stringify(frontier.heads)
  };
};

/** Only an authenticated current witness may introduce remote snapshot history. */
export const retainPersonalMembershipSnapshot = (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    snapshot: PersonalMembershipEntitySnapshot;
    witnessDeviceId: string;
    verifiedRecordHash: string;
  }
) => retainMembershipSnapshot(client, input);

/** Local history is linked to its immutable native audit, never to an invented signed receipt.
 * Caller holds the owner lock and supplies the private runtime's physical device identity.
 * Already retained ancestors retain their original author and proof on replay.
 */
export const retainLocalPersonalMembershipSnapshot = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    snapshot: PersonalMembershipEntitySnapshot;
    localDeviceId: string;
    nativeProjectId: string;
    nativeEntityId?: string;
    sourceBindingId?: string;
    nativeChanges: ReadonlyMap<string, string>;
  }
) => {
  const snapshot = translatePersonalMembershipSnapshotOwner(
    input.snapshot,
    input.ownerUserId
  );
  personalIdentifierSchema.parse(input.localDeviceId);
  for (const revision of snapshot.revisions) {
    const nativeId = input.nativeChanges.get(revision.revisionId);
    if (!nativeId) {
      const retained = await client.query(
        `select 1 from personal_membership_revisions where owner_user_id=$1 and project_identity=$2
         and entity_identity=$3 and revision_id=$4 and revision=$5::jsonb`,
        [
          input.ownerUserId,
          snapshot.project.projectId,
          snapshot.entityId,
          revision.revisionId,
          { ...revision, replaces: [...revision.replaces].sort() }
        ]
      );
      if (!retained.rowCount)
        throw new TypeError("PersonalMembershipLocalAncestryError");
      continue;
    }
    const operation = revision.operation;
    if (
      revision.authorDeviceId !== input.localDeviceId ||
      revision.revisionId !== nativeId
    )
      throw new TypeError("PersonalMembershipNativeAuditError");
    let audit: pg.QueryResult;
    if (
      snapshot.entityKind === "project" &&
      (operation.kind === "set_project" || operation.kind === "delete_project")
    ) {
      audit = await client.query(
        `select 1 from personal_membership_changes c where c.owner_user_id=$1 and c.revision_id=$2
         and c.project_id=$5 and c.entity_id=$5 and c.operation=$3
         and ($3='delete_project' or c.value->>'name'=$4)
         and coalesce(c.value->'portableMembership'->>'projectIdentity',c.project_id::text)=$6
         and coalesce(c.value->'portableMembership'->>'entityIdentity',c.entity_id::text)=$7
         and coalesce(c.value->'portableMembership'->'replaces',to_jsonb(c.replaces))=$8::jsonb`,
        [
          input.ownerUserId,
          nativeId,
          operation.kind,
          operation.kind === "set_project" ? operation.name : null,
          input.nativeProjectId,
          snapshot.project.projectId,
          snapshot.entityId,
          JSON.stringify([...revision.replaces].sort())
        ]
      );
    } else if (
      input.nativeEntityId &&
      input.sourceBindingId &&
      ((snapshot.entityKind === "direct" &&
        ((operation.kind === "include" &&
          operation.selector.kind === "session") ||
          operation.kind === "remove_inclusion")) ||
        (snapshot.entityKind === "exclusion" &&
          (operation.kind === "exclude" ||
            operation.kind === "clear_exclusion")))
    ) {
      const source = personalMembershipSourceFromSelectorKey(
        selectorKeyFor(snapshot)!,
        input.ownerUserId
      );
      const nativeTable =
        snapshot.entityKind === "direct"
          ? "personal_project_inclusions"
          : "personal_project_exclusions";
      const nativeColumn =
        snapshot.entityKind === "direct" ? "inclusion_id" : "exclusion_id";
      const nativeOperation =
        operation.kind === "include" ? "include_session" : operation.kind;
      // Exact owned native logical identity and a proven binding establish this
      // first portable alias. Historical native source_reference remains untouched.
      audit = await client.query(
        `select 1 from personal_membership_changes c
         join ${nativeTable} i on i.owner_user_id=c.owner_user_id and i.project_id=c.project_id and i.${nativeColumn}=c.entity_id
         join personal_source_bindings b on b.owner_user_id=i.owner_user_id and b.local_logical_session_id=i.logical_session_id
         join personal_membership_entities root on root.owner_user_id=i.owner_user_id and root.local_project_id=i.project_id
          and root.entity_kind='project' and root.project_identity=$10
         where c.owner_user_id=$1 and c.revision_id=$2 and c.project_id=$3 and c.entity_id=$4
          and c.operation=$5 and ($5='remove_inclusion' or c.value->>'logicalSessionId'=i.logical_session_id::text)
          and b.binding_id=$6 and b.originating_deployment_id=$7 and b.originating_device_id=$8 and b.source_logical_session_id=$9
          and (c.value->'portableMembership' is null or (
            c.value->'portableMembership'->>'projectIdentity'=$10 and c.value->'portableMembership'->>'entityIdentity'=$11))
          and coalesce(c.value->'portableMembership'->'replaces',to_jsonb(c.replaces))=$12::jsonb`,
        [
          input.ownerUserId,
          nativeId,
          input.nativeProjectId,
          input.nativeEntityId,
          nativeOperation,
          input.sourceBindingId,
          source.originatingDeploymentId,
          source.originatingDeviceId,
          source.logicalSessionId,
          snapshot.project.projectId,
          snapshot.entityId,
          JSON.stringify([...revision.replaces].sort())
        ]
      );
    } else if (
      snapshot.entityKind === "rule" &&
      input.nativeEntityId &&
      ((operation.kind === "include" &&
        operation.selector.kind !== "session") ||
        operation.kind === "remove_inclusion")
    ) {
      const scope = personalMembershipRuleScopeFromSelectorKey(
        selectorKeyFor(snapshot)!,
        input.ownerUserId
      );
      const nativeOperation =
        operation.kind === "include"
          ? operation.selector.kind === "repository"
            ? "include_repository"
            : "include_folder"
          : "remove_inclusion";
      audit = await client.query(
        `select 1 from personal_membership_changes c
         join personal_project_rules i on i.owner_user_id=c.owner_user_id and i.project_id=c.project_id and i.inclusion_id=c.entity_id
         join personal_membership_entities root on root.owner_user_id=i.owner_user_id and root.local_project_id=i.project_id
          and root.entity_kind='project' and root.project_identity=$8
         where c.owner_user_id=$1 and c.revision_id=$2 and c.project_id=$3 and c.entity_id=$4 and c.operation=$5
          and i.target_scope=$6 and ($5='remove_inclusion' or c.value->'target'=$7::jsonb)
          and (c.value->'portableMembership' is null or (
            c.value->'portableMembership'->>'projectIdentity'=$8 and c.value->'portableMembership'->>'entityIdentity'=$9))
          and coalesce(c.value->'portableMembership'->'replaces',to_jsonb(c.replaces))=$10::jsonb`,
        [
          input.ownerUserId,
          nativeId,
          input.nativeProjectId,
          input.nativeEntityId,
          nativeOperation,
          scope,
          operation.kind === "include" ? operation.selector : null,
          snapshot.project.projectId,
          snapshot.entityId,
          JSON.stringify([...revision.replaces].sort())
        ]
      );
    } else throw new TypeError("PersonalMembershipNativeAuditError");
    if (!audit.rowCount)
      throw new TypeError("PersonalMembershipNativeAuditError");
  }
  return retainMembershipSnapshot(client, {
    ownerUserId: input.ownerUserId,
    snapshot,
    witnessDeviceId: input.localDeviceId,
    verifiedRecordHash: null,
    nativeChanges: input.nativeChanges
  });
};

/** A retained applied User review proves local intent even when no source body
 * or native inclusion exists. It never invents transport or native-source proof.
 */
export const retainReviewedPersonalMembershipRevision = async (
  client: pg.PoolClient,
  input: { ownerUserId: string; reviewId: string }
) => {
  const found = await client.query<{
    project_identity: string;
    entity_identity: string;
    entity_kind: PersonalMembershipEntityKind;
    preview: unknown;
  }>(
    `select r.project_identity,r.entity_identity,e.entity_kind,r.preview
     from personal_membership_resolution_reviews r join personal_membership_entities e
      on e.owner_user_id=r.owner_user_id and e.project_identity=r.project_identity and e.entity_identity=r.entity_identity
     where r.owner_user_id=$1 and r.review_id=$2 and r.applied_at is not null`,
    [input.ownerUserId, input.reviewId]
  );
  const review = found.rows[0];
  if (!review) throw new TypeError("PersonalMembershipReviewProofError");
  const preview = personalMembershipReviewPreviewSchema.parse(review.preview);
  const retained = await client.query<{ revision: PersonalMembershipRevision }>(
    `select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2
     and entity_identity=$3 order by revision_id`,
    [input.ownerUserId, review.project_identity, review.entity_identity]
  );
  const snapshot = personalMembershipEntitySnapshotSchema.parse({
    version: 1,
    project: preview.after.project,
    entityId: review.entity_identity,
    entityKind: review.entity_kind,
    revisions: [...retained.rows.map((row) => row.revision), preview.after]
  });
  return retainMembershipSnapshot(client, {
    ownerUserId: input.ownerUserId,
    snapshot,
    witnessDeviceId: preview.after.authorDeviceId,
    verifiedRecordHash: null,
    localReviews: new Map([[preview.after.revisionId, input.reviewId]])
  });
};
