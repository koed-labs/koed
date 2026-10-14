import { z } from "zod";

export const repositoryIdentitySchema = z
  .object({
    kind: z.enum([
      "portable_repository",
      "device_local_repository",
      "non_git_project",
      "unresolved"
    ]),
    key: z.string().min(1).max(512).nullable(),
    root: z.string().min(1).max(8192).nullable(),
    branch: z.string().min(1).max(512).nullable(),
    reason: z.enum([
      "local_selection",
      "replicated_selection",
      "upstream",
      "origin",
      "local_fallback",
      "non_git",
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
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "unresolved") !== (value.key === null)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Unresolved identities have no matching key; resolved identities require one."
      });
    }
  });
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

// A caller supplies this only for an already established Project association.
// This input does not establish an association or authorize any Workspace.
export type AssociatedRepositorySelection = {
  associationId: string;
  selection:
    | { state: "selected"; anchorFingerprint: string }
    | { state: "conflict" };
};
