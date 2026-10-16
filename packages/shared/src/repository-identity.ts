import { z } from "zod";

const identityFields = {
  root: z.string().min(1).max(8192).nullable(),
  branch: z.string().min(1).max(512).nullable(),
  reason: z.enum([
    "local_selection",
    "replicated_selection",
    "upstream",
    "origin",
    "local_fallback",
    "non_git",
    "manual",
    "probe_failed",
    "probe_ambiguous",
    "checkout_unavailable",
    "selection_missing",
    "selection_not_portable",
    "selection_conflict",
    "replicated_anchor_missing"
  ]),
  checkoutId: z.string().min(1).max(128).nullable(),
  originatingDeviceId: z.string().min(1).max(128),
  selectedRemote: z.string().min(1).max(512).nullable(),
  anchorDisplay: z.string().min(1).max(512).nullable()
};
const key = z.string().min(1).max(512);
export const repositoryIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({ ...identityFields, kind: z.literal("portable_repository"), key })
    .strict(),
  z
    .object({
      ...identityFields,
      kind: z.literal("device_local_repository"),
      key
    })
    .strict(),
  z
    .object({ ...identityFields, kind: z.literal("non_git_project"), key })
    .strict(),
  z
    .object({
      ...identityFields,
      kind: z.literal("local_project"),
      key,
      reason: z.literal("manual"),
      root: z.null(),
      branch: z.null(),
      checkoutId: z.null(),
      selectedRemote: z.null(),
      anchorDisplay: z.null()
    })
    .strict(),
  z
    .object({ ...identityFields, kind: z.literal("unresolved"), key: z.null() })
    .strict()
]);
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;
export type ResolvedRepositoryIdentity = Exclude<
  RepositoryIdentity,
  { kind: "unresolved" }
>;

// A caller supplies this only for an already established Project association.
// This input does not establish an association or authorize any Workspace.
export type AssociatedRepositorySelection = {
  associationId: string;
  selection:
    | { state: "selected"; anchorFingerprint: string }
    | { state: "conflict" };
};
