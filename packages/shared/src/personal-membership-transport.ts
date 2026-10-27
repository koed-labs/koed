import { personalProjectSourceSelectorKey } from "./personal-project-source-target.js";
import { selectPersonalMembershipHead } from "./personal-membership-contract.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  personalMembershipRevisionSchema,
  personalInclusionSelectorSchema,
  type PersonalMembershipRevision
} from "./personal-membership-contract.js";
import {
  personalIdentifierSchema,
  personalProjectReferenceSchema,
  personalSourceReferenceSchema,
  personalFolderReferenceSchema,
  personalFolderScopeId
} from "./personal-source-contract.js";
import {
  canonicalizePdsJson,
  parseCanonicalPdsJson
} from "./personal-device-sync-jcs.js";

export type PersonalMembershipEntityKind =
  | "project"
  | "direct"
  | "rule"
  | "exclusion";
const sourceIdentity = (
  value: z.infer<typeof personalSourceReferenceSchema>
) => {
  const source = personalSourceReferenceSchema.parse(value);
  return {
    originatingDeploymentId: source.originatingDeploymentId,
    originatingDeviceId: source.originatingDeviceId,
    logicalSessionId: source.logicalSessionId
  };
};
/** Equal names, provider identifiers, and paths do not establish an inclusion identity. */
export const personalMembershipSelectorKey = (
  raw: z.infer<typeof personalInclusionSelectorSchema>
): string => {
  const selector = personalInclusionSelectorSchema.parse(raw);
  if (selector.kind === "session")
    return canonicalizePdsJson({
      kind: "session",
      source: sourceIdentity(selector.source)
    });
  return personalProjectSourceSelectorKey(selector);
};
/** Decode only a canonical source selector, with the authenticated local owner supplied separately. */
export const personalMembershipSourceFromSelectorKey = (
  key: string,
  ownerUserId: string
) => {
  const parsed = z
    .object({
      kind: z.literal("session"),
      source: personalSourceReferenceSchema.omit({ ownerUserId: true })
    })
    .strict()
    .parse(parseCanonicalPdsJson(key));
  return personalSourceReferenceSchema.parse({ ...parsed.source, ownerUserId });
};
/** Native rule scopes include the receiving owner for Folder references; the
 * portable selector identity deliberately excludes that owner alias.
 */
export const personalMembershipRuleScopeFromSelectorKey = (
  key: string,
  ownerUserId: string
): string => {
  const parsed = z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("repository"),
          scope: z.string().min(1).max(2048)
        })
        .strict(),
      z
        .object({
          kind: z.literal("folder"),
          reference: personalFolderReferenceSchema.omit({ ownerUserId: true })
        })
        .strict()
    ])
    .parse(parseCanonicalPdsJson(key));
  return parsed.kind === "repository"
    ? parsed.scope
    : personalFolderScopeId({ ...parsed.reference, ownerUserId });
};

/** Concurrent adds of the same exact source or rule address one portable entity. */
export const personalMembershipInclusionIdentity = (
  projectId: string,
  selector: z.infer<typeof personalInclusionSelectorSchema>
): string =>
  `inclusion_${createHash("sha256")
    .update(
      canonicalizePdsJson({
        projectId: personalIdentifierSchema.parse(projectId),
        selector: personalMembershipSelectorKey(selector)
      })
    )
    .digest("hex")}`;
export const personalMembershipExclusionIdentity = (
  projectId: string,
  source: z.infer<typeof personalSourceReferenceSchema>
): string =>
  `exclusion_${createHash("sha256")
    .update(
      canonicalizePdsJson({
        projectId: personalIdentifierSchema.parse(projectId),
        source: sourceIdentity(source)
      })
    )
    .digest("hex")}`;

const operationKind = (
  revision: PersonalMembershipRevision
): PersonalMembershipEntityKind | undefined => {
  const operation = revision.operation;
  if (operation.kind === "set_project" || operation.kind === "delete_project")
    return "project";
  if (operation.kind === "exclude" || operation.kind === "clear_exclusion")
    return "exclusion";
  if (operation.kind === "include")
    return operation.selector.kind === "session" ? "direct" : "rule";
  return undefined;
};
export const personalMembershipEntitySnapshotSchema = z
  .object({
    version: z.literal(1),
    project: personalProjectReferenceSchema,
    entityId: personalIdentifierSchema,
    entityKind: z.enum(["project", "direct", "rule", "exclusion"]),
    revisions: z.array(personalMembershipRevisionSchema).min(1).max(4096)
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const records = new Map<string, PersonalMembershipRevision>();
    let selectorKey: string | undefined;
    let expectedEntityId: string | undefined;
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const revision of snapshot.revisions) {
      if (
        revision.project.ownerUserId !== snapshot.project.ownerUserId ||
        revision.project.projectId !== snapshot.project.projectId ||
        revision.entityId !== snapshot.entityId
      )
        fail("Membership history addresses another Project or entity");
      if (records.has(revision.revisionId))
        fail("Membership history contains duplicate revisions");
      records.set(revision.revisionId, revision);
      const kind = operationKind(revision);
      if (kind !== undefined && kind !== snapshot.entityKind)
        fail("Membership history changes its entity kind");
      if (revision.operation.kind === "include") {
        const key = personalMembershipSelectorKey(revision.operation.selector);
        expectedEntityId = personalMembershipInclusionIdentity(
          snapshot.project.projectId,
          revision.operation.selector
        );
        if (selectorKey !== undefined && selectorKey !== key)
          fail("Membership history changes its inclusion selector");
        selectorKey = key;
      } else if (revision.operation.kind === "exclude") {
        const key = canonicalizePdsJson(
          sourceIdentity(revision.operation.source)
        );
        expectedEntityId = personalMembershipExclusionIdentity(
          snapshot.project.projectId,
          revision.operation.source
        );
        if (selectorKey !== undefined && selectorKey !== key)
          fail("Membership history changes its excluded source");
        selectorKey = key;
      }
    }
    if (
      snapshot.entityKind === "project" &&
      snapshot.entityId !== snapshot.project.projectId
    )
      fail("Project history must address its Project identity");
    if (snapshot.entityKind !== "project" && selectorKey === undefined)
      fail("Membership history lacks its original selector");
    if (
      snapshot.entityKind === "project" &&
      snapshot.revisions.some(
        (revision) => revision.operation.kind === "remove_inclusion"
      )
    )
      fail("An inclusion removal cannot address the Project catalog");
    if (
      snapshot.entityKind === "exclusion" &&
      snapshot.revisions.some(
        (revision) => revision.operation.kind === "remove_inclusion"
      )
    )
      fail("An inclusion removal cannot address an exclusion");
    if (
      snapshot.entityKind !== "project" &&
      expectedEntityId !== snapshot.entityId
    )
      fail("Membership history does not use its canonical selector identity");
    try {
      const graph = evaluatePersonalMembershipRevisions(snapshot.revisions);
      if (graph.state === "pending")
        fail(
          "Membership snapshot does not contain its complete causal history"
        );
    } catch {
      fail("Membership history has an invalid causal graph");
    }
  });
export type PersonalMembershipEntitySnapshot = z.infer<
  typeof personalMembershipEntitySnapshotSchema
>;

/** Causal edges select the frontier. Names, clocks, counters, and delivery order do not. */
export const evaluatePersonalMembershipRevisions = (
  input: readonly PersonalMembershipRevision[]
): {
  state: "pending" | "conflict" | "available";
  heads: string[];
  revision: PersonalMembershipRevision | null;
} => {
  const rows = input.map((value) =>
    personalMembershipRevisionSchema.parse(value)
  );
  const first = rows[0];
  if (
    first &&
    rows.some(
      (revision) =>
        revision.project.ownerUserId !== first.project.ownerUserId ||
        revision.project.projectId !== first.project.projectId ||
        revision.entityId !== first.entityId
    )
  )
    throw new TypeError("Membership history addresses different entities");
  const records = new Map(
    rows.map((revision) => [revision.revisionId, revision])
  );
  if (records.size !== rows.length)
    throw new TypeError("Membership history contains duplicate revisions");
  const children = new Map<string, string[]>(),
    remaining = new Map<string, number>();
  let missing = false;
  for (const revision of rows) {
    remaining.set(
      revision.revisionId,
      revision.replaces.filter((parent) => records.has(parent)).length
    );
    for (const parent of revision.replaces) {
      if (!records.has(parent)) missing = true;
      children.set(parent, [
        ...(children.get(parent) ?? []),
        revision.revisionId
      ]);
    }
  }
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
  if (visited !== records.size)
    throw new TypeError("Membership history contains a cycle");
  const heads = [...records.keys()].filter((id) => !children.has(id)).sort();
  if (missing || !heads.length)
    return { state: "pending", heads, revision: null };
  const revision = selectPersonalMembershipHead(
    heads.map((id) => records.get(id)!)
  );
  if (!revision) return { state: "conflict", heads, revision: null };
  return { state: "available", heads, revision };
};

// Personal transport canonical JSON forbids numeric values. Domain version 1
// crosses the wire as a decimal string; there are no arrival-time fields.
const wireRevision = z
  .object({
    ...personalMembershipRevisionSchema.shape,
    version: z.literal("1")
  })
  .strict();
const wireSnapshot = z
  .object({
    version: z.literal("1"),
    project: personalProjectReferenceSchema,
    entityId: personalIdentifierSchema,
    entityKind: z.enum(["project", "direct", "rule", "exclusion"]),
    revisions: z.array(wireRevision).min(1).max(4096)
  })
  .strict();
export type PdsPersonalMembershipEntitySnapshot = z.infer<typeof wireSnapshot>;
export const encodePdsPersonalMembershipEntitySnapshot = (
  raw: unknown
): PdsPersonalMembershipEntitySnapshot => {
  const snapshot = personalMembershipEntitySnapshotSchema.parse(raw);
  return wireSnapshot.parse({
    ...snapshot,
    version: "1",
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      version: "1"
    }))
  });
};
export const decodePdsPersonalMembershipEntitySnapshot = (
  raw: unknown
): PersonalMembershipEntitySnapshot => {
  const snapshot = wireSnapshot.parse(raw);
  return personalMembershipEntitySnapshotSchema.parse({
    ...snapshot,
    version: 1,
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      version: 1
    }))
  });
};
/** The signed witness is current authority; authorDeviceId retains historical provenance. */
export const pdsPersonalMembershipEntitySnapshotSchema =
  wireSnapshot.superRefine((snapshot, ctx) => {
    try {
      decodePdsPersonalMembershipEntitySnapshot(snapshot);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Membership configuration history is invalid"
      });
    }
  });
