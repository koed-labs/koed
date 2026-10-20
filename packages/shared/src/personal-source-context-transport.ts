import { z } from "zod";
import {
  personalSourceContextSchema,
  personalSourceReferenceSchema,
  personalIdentifierSchema,
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema
} from "./personal-source-contract.js";

const revisionFields = {
  revisionId: personalIdentifierSchema,
  replaces: z.array(personalIdentifierSchema).max(1024)
};
export const personalGitContextRevisionSchema = z
  .object({ ...revisionFields, assignment: personalGitAssignmentSchema })
  .strict();
export const personalFolderContextRevisionSchema = z
  .object({ ...revisionFields, assignment: personalFolderAssignmentSchema })
  .strict();

/** Complete signed origin history. Replica edits travel in the separate configuration journal. */
export const personalSourceContextSnapshotSchema = z
  .object({
    version: z.literal("1"),
    context: personalSourceContextSchema,
    git: z
      .object({
        head: personalIdentifierSchema,
        revisions: z.array(personalGitContextRevisionSchema).min(1).max(2048)
      })
      .strict(),
    folder: z
      .object({
        head: personalIdentifierSchema,
        revisions: z.array(personalFolderContextRevisionSchema).min(1).max(2048)
      })
      .strict()
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (const axis of ["git", "folder"] as const) {
      const history = snapshot[axis],
        current = snapshot.context[axis];
      const records = new Map(
        history.revisions.map((revision) => [revision.revisionId, revision])
      );
      const fail = (message: string) =>
        ctx.addIssue({ code: "custom", path: [axis], message });
      if (records.size !== history.revisions.length) {
        fail("Source context history contains duplicate revisions");
        continue;
      }
      const head = records.get(history.head);
      if (!head || JSON.stringify(head.assignment) !== JSON.stringify(current))
        fail("Source context head does not bind its assignment");
      const children = new Map<string, string[]>(),
        remaining = new Map<string, number>();
      let valid = true;
      for (const revision of history.revisions) {
        if (
          revision.assignment.correction.state === "corrected" &&
          revision.assignment.correction.revisionId !== revision.revisionId
        )
          fail("A corrected assignment must identify its causal revision");
        if (
          JSON.stringify(revision.assignment.original) !==
          JSON.stringify(current.original)
        )
          fail("Source context history cannot replace original provenance");
        if (
          new Set(revision.replaces).size !== revision.replaces.length ||
          revision.replaces.some(
            (parent) => !records.has(parent) || parent === revision.revisionId
          )
        ) {
          fail("Source context history has an invalid reviewed frontier");
          valid = false;
        }
        remaining.set(revision.revisionId, revision.replaces.length);
        for (const parent of revision.replaces)
          children.set(parent, [
            ...(children.get(parent) ?? []),
            revision.revisionId
          ]);
      }
      if (!valid) continue;
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
        fail("Source context history contains a cycle");
      const frontier = [...records.keys()].filter((id) => !children.has(id));
      if (frontier.length !== 1 || frontier[0] !== history.head)
        fail(
          "Source context snapshot requires one complete causal head per context"
        );
      if (axis === "folder")
        for (const revision of snapshot.folder.revisions) {
          const assignment = revision.assignment;
          for (const fact of [
            assignment.original,
            ...(assignment.correction.state === "corrected"
              ? [assignment.correction.value]
              : [])
          ])
            if (
              fact.state === "known" &&
              fact.value.reference.ownerUserId !==
                snapshot.context.source.ownerUserId
            )
              fail("Folder history belongs to another owner");
        }
    }
  });
export type PersonalSourceContextSnapshot = z.infer<
  typeof personalSourceContextSnapshotSchema
>;

// PDS canonical JSON forbids numeric JSON values. Native counters cross the wire as decimal strings.
const decimalRevision = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    "Source revision exceeds the supported range"
  );
const wireGitAssignment = personalGitAssignmentSchema
  .omit({ revision: true })
  .extend({ revision: decimalRevision })
  .strict();
const wireFolderAssignment = personalFolderAssignmentSchema
  .omit({ revision: true })
  .extend({ revision: decimalRevision })
  .strict();
const wireContext = z
  .object({
    version: z.literal("1"),
    source: personalSourceReferenceSchema,
    git: wireGitAssignment,
    folder: wireFolderAssignment
  })
  .strict();
export const pdsPersonalSourceContextSnapshotSchema = z
  .object({
    version: z.literal("1"),
    context: wireContext,
    git: z
      .object({
        head: personalIdentifierSchema,
        revisions: z
          .array(
            z
              .object({ ...revisionFields, assignment: wireGitAssignment })
              .strict()
          )
          .min(1)
          .max(2048)
      })
      .strict(),
    folder: z
      .object({
        head: personalIdentifierSchema,
        revisions: z
          .array(
            z
              .object({ ...revisionFields, assignment: wireFolderAssignment })
              .strict()
          )
          .min(1)
          .max(2048)
      })
      .strict()
  })
  .strict();
export type PdsPersonalSourceContextSnapshot = z.infer<
  typeof pdsPersonalSourceContextSnapshotSchema
>;
export const encodePdsPersonalSourceContextSnapshot = (
  raw: unknown
): PdsPersonalSourceContextSnapshot => {
  const snapshot = personalSourceContextSnapshotSchema.parse(raw);
  return pdsPersonalSourceContextSnapshotSchema.parse({
    ...snapshot,
    context: {
      ...snapshot.context,
      version: "1",
      git: {
        ...snapshot.context.git,
        revision: String(snapshot.context.git.revision)
      },
      folder: {
        ...snapshot.context.folder,
        revision: String(snapshot.context.folder.revision)
      }
    },
    git: {
      ...snapshot.git,
      revisions: snapshot.git.revisions.map((revision) => ({
        ...revision,
        assignment: {
          ...revision.assignment,
          revision: String(revision.assignment.revision)
        }
      }))
    },
    folder: {
      ...snapshot.folder,
      revisions: snapshot.folder.revisions.map((revision) => ({
        ...revision,
        assignment: {
          ...revision.assignment,
          revision: String(revision.assignment.revision)
        }
      }))
    }
  });
};
export const decodePdsPersonalSourceContextSnapshot = (
  raw: unknown
): PersonalSourceContextSnapshot => {
  const snapshot = pdsPersonalSourceContextSnapshotSchema.parse(raw);
  return personalSourceContextSnapshotSchema.parse({
    ...snapshot,
    context: {
      ...snapshot.context,
      version: 1,
      git: {
        ...snapshot.context.git,
        revision: Number(snapshot.context.git.revision)
      },
      folder: {
        ...snapshot.context.folder,
        revision: Number(snapshot.context.folder.revision)
      }
    },
    git: {
      ...snapshot.git,
      revisions: snapshot.git.revisions.map((revision) => ({
        ...revision,
        assignment: {
          ...revision.assignment,
          revision: Number(revision.assignment.revision)
        }
      }))
    },
    folder: {
      ...snapshot.folder,
      revisions: snapshot.folder.revisions.map((revision) => ({
        ...revision,
        assignment: {
          ...revision.assignment,
          revision: Number(revision.assignment.revision)
        }
      }))
    }
  });
};

/** Structural binding only. Package signature and current device authority remain separate checks. */
export const validatePdsSourceContextOriginBinding = (input: {
  snapshot: unknown;
  originDeploymentId: string;
  originDeviceId: string;
  logicalSessionId: string;
}): PersonalSourceContextSnapshot => {
  const snapshot = decodePdsPersonalSourceContextSnapshot(input.snapshot),
    source = snapshot.context.source;
  if (
    source.originatingDeploymentId !== input.originDeploymentId ||
    source.originatingDeviceId !== input.originDeviceId ||
    source.logicalSessionId !== input.logicalSessionId
  )
    throw new TypeError(
      "Personal source context does not bind the verified origin and logical Conversation"
    );
  return snapshot;
};
