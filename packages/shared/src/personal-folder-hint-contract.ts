import { z } from "zod";
import {
  personalFolderAssignmentSchema,
  personalFolderObservationSchema,
  personalFolderReferenceSchema,
  personalOwnerIdSchema
} from "./personal-source-contract.js";

/** Largest batch of Conversations a single hint request may name. */
export const PERSONAL_FOLDER_HINT_BATCH_SIZE = 50;

export const personalFolderHintRequestSchema = z
  .object({
    sessionIds: z.array(z.uuid()).min(1).max(PERSONAL_FOLDER_HINT_BATCH_SIZE)
  })
  .strict();
export type PersonalFolderHintRequest = z.infer<
  typeof personalFolderHintRequestSchema
>;

/** Recorded, owner-scoped facts the API exposes for scoring. The scorer adds
 * current, device-local evidence; the API never sees the local filesystem. */
export const personalFolderHintEvidenceSchema = z
  .object({
    ownerUserId: personalOwnerIdSchema,
    evidence: z
      .array(
        z
          .object({
            sessionId: z.uuid(),
            folderAssignment: personalFolderAssignmentSchema,
            recordedCwd: z.string().max(4096).nullable(),
            firstConversationAt: z
              .string()
              .datetime({ offset: true })
              .nullable(),
            recordedRemoteFingerprint: z.string().max(256).nullable(),
            /** False for a replica received from another device. */
            capturedOnThisDevice: z.boolean(),
            /** True when the Conversation already has a Git Anchor, automatic or
             * chosen, so no anchor needs suggesting. Absent means unknown. */
            gitAnchorKnown: z.boolean().optional(),
            /** The AI Client that produced the Conversation, e.g. "claude-code". */
            sourceRuntime: z.string().max(64).nullable().optional(),
            /** The client's own session id, used only to find its local record. */
            externalSessionId: z.string().max(1024).nullable().optional()
          })
          .strict()
      )
      .max(PERSONAL_FOLDER_HINT_BATCH_SIZE)
  })
  .strict();
export type PersonalFolderHintEvidence = z.infer<
  typeof personalFolderHintEvidenceSchema
>;

export const personalFolderHintReasonSchema = z
  .object({
    code: z.string().min(1).max(64),
    outcome: z.enum(["agrees", "does-not-agree", "unavailable", "rejects"])
  })
  .strict();

/** Advisory only. A hint is never a Folder observation, selection or repair. */
export const personalFolderHintSchema = z
  .object({
    sessionId: z.uuid(),
    tier: z.enum(["none", "medium", "strong"]),
    /** Absent means a registered Folder. A worktree-parent hint names the main
     * checkout's Folder; a create hint names a directory with no Folder yet. */
    kind: z
      .enum(["registered", "worktree-parent", "create", "repository"])
      .optional(),
    /** A repository hint names the Git Anchor of the directory's current remote
     * (its portable fingerprint, the same key whatever the protocol). */
    repositoryKey: z.string().min(1).max(256).optional(),
    score: z.number().int().min(0).max(8),
    folder: personalFolderReferenceSchema.optional(),
    /** The directory a create hint would register, or the directory of the
     * suggested Folder, for display. */
    directory: z.string().min(1).max(4096).optional(),
    reasons: z.array(personalFolderHintReasonSchema).max(32)
  })
  .strict()
  .refine(
    (hint) =>
      hint.tier === "none"
        ? hint.folder === undefined &&
          hint.directory === undefined &&
          hint.kind === undefined &&
          hint.repositoryKey === undefined
        : hint.kind === "create"
          ? hint.directory !== undefined &&
            hint.folder === undefined &&
            hint.repositoryKey === undefined
          : hint.kind === "repository"
            ? hint.repositoryKey !== undefined && hint.folder === undefined
            : hint.folder !== undefined && hint.repositoryKey === undefined,
    { message: "A hint names exactly the candidate its kind describes" }
  );
export type PersonalFolderHint = z.infer<typeof personalFolderHintSchema>;

/** A Conversation can return one hint per kind (registered, worktree-parent,
 * repository, create), so a batch can hold several hints per Conversation. */
export const PERSONAL_FOLDER_HINTS_PER_CONVERSATION = 4;

export const personalFolderHintsDataSchema = z
  .object({
    hints: z
      .array(personalFolderHintSchema)
      .max(
        PERSONAL_FOLDER_HINT_BATCH_SIZE * PERSONAL_FOLDER_HINTS_PER_CONVERSATION
      )
  })
  .strict();

/** Explicit confirmation to register the directory a `create` hint named. */
export const personalFolderHintCreateRequestSchema = z
  .object({
    sessionId: z.uuid(),
    /** Which candidate is being accepted. Defaults to registering a new Folder. */
    kind: z.enum(["registered", "worktree-parent", "create"]).optional()
  })
  .strict();
export type PersonalFolderHintCreateRequest = z.infer<
  typeof personalFolderHintCreateRequestSchema
>;

/** The Folder the confirmed registration produced. It is not yet assigned. */
export const personalFolderHintCreateDataSchema = z
  .object({
    folder: personalFolderReferenceSchema,
    normalizedPath: z.string().min(1).max(4096)
  })
  .strict();

/** Body sent to the API so the new Folder becomes known to the owner. */
export const personalFolderObservationRecordSchema = z
  .object({ observation: personalFolderObservationSchema })
  .strict();
