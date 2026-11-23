import { z } from "zod";
import {
  personalFolderAssignmentSchema,
  personalFolderReferenceSchema,
  personalOwnerIdSchema
} from "./personal-source-contract.js";

/** Largest batch of Conversations a single hint request may name. */
export const PERSONAL_FOLDER_HINT_BATCH_SIZE = 50;
/** One registered Folder and one worktree parent per Conversation. */
const MAX_PROPOSED_FOLDERS = 2 * PERSONAL_FOLDER_HINT_BATCH_SIZE;

export const personalFolderHintRequestSchema = z
  .object({
    sessionIds: z.array(z.uuid()).min(1).max(PERSONAL_FOLDER_HINT_BATCH_SIZE)
  })
  .strict();
export type PersonalFolderHintRequest = z.infer<
  typeof personalFolderHintRequestSchema
>;

export const personalFolderHintEvidenceRequestSchema =
  personalFolderHintRequestSchema.extend({
    proposedFolders: z
      .array(personalFolderReferenceSchema)
      .max(MAX_PROPOSED_FOLDERS)
      .optional()
  });

const gitInferenceEvidence = {
  gitRevision: z.number().int().positive().safe().optional(),
  gitInferenceEligibility: z.boolean().optional(),
  recordingDeviceProvenance: z
    .enum(["recording-device", "known-copy", "unknown"])
    .optional()
};

/** Recorded, owner-scoped facts the API exposes for scoring. The scorer adds
 * current, device-local evidence; the API never sees the local filesystem. */
export const personalFolderHintEvidenceSchema = z
  .object({
    ownerUserId: personalOwnerIdSchema,
    /** Subset of proposed references eligible for Folder correction. */
    knownFolders: z
      .array(personalFolderReferenceSchema)
      .max(MAX_PROPOSED_FOLDERS)
      .optional(),
    evidence: z
      .array(
        z
          .object({
            sessionId: z.uuid(),
            folderAssignment: personalFolderAssignmentSchema,
            recordedCwd: z.string().max(4096).nullable(),
            /** Source-native start, never capture or import time. */
            firstConversationAt: z
              .string()
              .datetime({ offset: true })
              .nullable(),
            recordedRemoteFingerprint: z.string().max(256).nullable(),
            /** True only with positive recording-device evidence. */
            capturedOnThisDevice: z.boolean(),
            /** True when the Conversation already has a Git Anchor, automatic or
             * chosen, so no anchor needs suggesting. Absent means unknown. */
            gitAnchorKnown: z.boolean().optional(),
            ...gitInferenceEvidence,
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
    ...gitInferenceEvidence,
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

/** Read-only confirmation of the exact existing Folder the User reviewed. */
export const personalFolderHintConfirmRequestSchema = z
  .object({
    sessionId: z.uuid(),
    kind: z.enum(["registered", "worktree-parent"]),
    folder: personalFolderReferenceSchema
  })
  .strict();

export const personalFolderHintConfirmDataSchema = z
  .object({ folder: personalFolderReferenceSchema })
  .strict();
