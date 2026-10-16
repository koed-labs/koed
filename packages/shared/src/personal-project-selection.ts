import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalizePdsJson } from "./personal-device-sync-jcs.js";
import {
  decodePdsBase64url,
  pdsEd25519PublicKey
} from "./personal-device-sync.js";
import type { AssociatedRepositorySelection } from "./repository-identity.js";

export const PDS_PROJECT_SELECTION_PROTOCOL = "koed/pds-project-selection/v1";
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const operation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set"),
      anchorFingerprint: z.string().min(4).max(512).startsWith("gr_")
    })
    .strict(),
  z.object({ kind: z.literal("delete") }).strict()
]);

/** Configuration payload. It is signed, then encrypted by the PDS transport. */
export const pdsProjectSelectionRevisionSchema = z
  .object({
    protocol: z.literal(PDS_PROJECT_SELECTION_PROTOCOL),
    groupId: identifier,
    associationId: identifier,
    selectionId: identifier,
    revisionId: identifier,
    authorDeviceId: identifier,
    authorSigningKeyId: identifier,
    replaces: z.array(identifier).max(1024),
    operation
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.replaces).size !== value.replaces.length ||
      value.replaces.includes(value.revisionId)
    )
      ctx.addIssue({ code: "custom", message: "Invalid replaced revisions" });
  });
export type PdsProjectSelectionRevision = z.infer<
  typeof pdsProjectSelectionRevisionSchema
>;
export const pdsProjectSelectionRecordSchema = z
  .object({
    revision: pdsProjectSelectionRevisionSchema,
    signature: z.string().refine((value) => {
      try {
        decodePdsBase64url(value, 64);
        return true;
      } catch {
        return false;
      }
    }, "Invalid Project selection signature")
  })
  .strict();
export type PdsProjectSelectionRecord = z.infer<
  typeof pdsProjectSelectionRecordSchema
>;

const signingBytes = (revision: PdsProjectSelectionRevision): Buffer =>
  Buffer.from(
    `${PDS_PROJECT_SELECTION_PROTOCOL}/revision\n${canonicalizePdsJson(revision)}`
  );

/** Each authenticated transport can replay the same immutable revision independently. */
export const pdsProjectSelectionPackageId = (
  recordHash: string,
  transportId: string
): string => {
  decodePdsBase64url(recordHash, 32);
  decodePdsBase64url(transportId, 32);
  return createHash("sha256")
    .update(
      `${PDS_PROJECT_SELECTION_PROTOCOL}/delivery\0${recordHash}\0${transportId}`
    )
    .digest("base64url");
};

export const signPdsProjectSelection = (
  input: PdsProjectSelectionRevision,
  signingPrivateKey: KeyObject
): PdsProjectSelectionRecord => {
  const revision = pdsProjectSelectionRevisionSchema.parse(input);
  return pdsProjectSelectionRecordSchema.parse({
    revision,
    signature: sign(null, signingBytes(revision), signingPrivateKey).toString(
      "base64url"
    )
  });
};

/** Caller supplies an Authority-verified certificate from this exact group. */
export const verifyPdsProjectSelection = (
  input: unknown,
  author: {
    groupId: string;
    deviceId: string;
    signingKeyId: string;
    publicKey: string | Buffer | KeyObject;
  }
): PdsProjectSelectionRecord => {
  const record = pdsProjectSelectionRecordSchema.parse(input);
  if (
    record.revision.groupId !== author.groupId ||
    record.revision.authorDeviceId !== author.deviceId ||
    record.revision.authorSigningKeyId !== author.signingKeyId
  )
    throw new TypeError("PDS Project selection author is unauthorized");
  const key =
    typeof author.publicKey === "object" && "type" in author.publicKey
      ? (author.publicKey as KeyObject)
      : pdsEd25519PublicKey(author.publicKey as string | Buffer);
  if (
    !verify(
      null,
      signingBytes(record.revision),
      key,
      Buffer.from(record.signature, "base64url")
    )
  )
    throw new TypeError("PDS Project selection signature is invalid");
  return record;
};

export type PdsProjectSelectionState = {
  heads: string[];
  revisions: PdsProjectSelectionRevision[];
} & (
  | { state: "absent" | "deleted" }
  | { state: "selected"; anchorFingerprint: string }
  | { state: "conflict" }
  | { state: "incomplete"; missingRevisions: string[] }
);

/** A causal DAG, never a last-arrival or last-clock register. Keep tombstones. */
export const resolvePdsProjectSelection = (
  scope: { groupId: string; associationId: string; selectionId: string },
  input: readonly PdsProjectSelectionRevision[]
): PdsProjectSelectionState => {
  const revisions = new Map<string, PdsProjectSelectionRevision>();
  for (const value of input) {
    const revision = pdsProjectSelectionRevisionSchema.parse(value);
    if (
      revision.groupId !== scope.groupId ||
      revision.associationId !== scope.associationId ||
      revision.selectionId !== scope.selectionId
    )
      throw new TypeError("PDS Project selection scope differs");
    const existing = revisions.get(revision.revisionId);
    if (
      existing &&
      canonicalizePdsJson(existing) !== canonicalizePdsJson(revision)
    )
      throw new TypeError("PDS Project selection revision was reused");
    revisions.set(revision.revisionId, revision);
  }
  const missing = new Set<string>();
  const replaced = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const start of revisions.keys()) {
    const stack = [{ id: start, exit: false }];
    while (stack.length) {
      const { id, exit } = stack.pop()!;
      if (exit) {
        visiting.delete(id);
        visited.add(id);
        continue;
      }
      if (visited.has(id)) continue;
      if (visiting.has(id))
        throw new TypeError("PDS Project selection causal cycle");
      const revision = revisions.get(id);
      if (!revision) {
        missing.add(id);
        continue;
      }
      visiting.add(id);
      stack.push({ id, exit: true });
      for (const parent of revision.replaces) {
        replaced.add(parent);
        stack.push({ id: parent, exit: false });
      }
    }
  }
  const ordered = [...revisions.values()].sort((a, b) =>
    a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0
  );
  const heads = ordered
    .filter((value) => !replaced.has(value.revisionId))
    .map((value) => value.revisionId);
  const base = { heads, revisions: ordered };
  if (missing.size)
    return {
      ...base,
      state: "incomplete",
      missingRevisions: [...missing].sort()
    };
  if (!heads.length) return { ...base, state: "absent" };
  if (heads.length !== 1) return { ...base, state: "conflict" };
  const head = revisions.get(heads[0]!)!;
  return head.operation.kind === "delete"
    ? { ...base, state: "deleted" }
    : {
        ...base,
        state: "selected",
        anchorFingerprint: head.operation.anchorFingerprint
      };
};

/** Use only after local acceptance of this association for a live checkout. */
export const associatedSelectionFromPdsState = (
  associationId: string,
  state: PdsProjectSelectionState
): AssociatedRepositorySelection | undefined => {
  if (state.state === "absent" || state.state === "deleted") return undefined;
  return {
    associationId,
    selection:
      state.state === "selected"
        ? { state: "selected", anchorFingerprint: state.anchorFingerprint }
        : { state: "conflict" }
  };
};

/** The persistence transaction must lock and recheck these reviewed heads. */
export const requireReviewedProjectSelectionHeads = (
  state: PdsProjectSelectionState,
  reviewedHeads: readonly string[]
): string[] => {
  if (state.state === "incomplete")
    throw new Error("Project selection history is incomplete");
  const reviewed = [...reviewedHeads].sort();
  if (
    new Set(reviewed).size !== reviewed.length ||
    canonicalizePdsJson(reviewed) !==
      canonicalizePdsJson([...state.heads].sort())
  )
    throw new Error("Project selection changed; review its current revisions");
  return reviewed;
};
