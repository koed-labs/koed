import { z } from "zod";

export const projectSourceKindSchema = z.enum([
  "doc",
  "folder",
  "repo",
  "skill"
]);
export const projectSourceStatusSchema = z.enum([
  "uploading",
  "extracting",
  "ready",
  "failed"
]);
export const projectSourceFailureSchema = z.enum([
  "unsupported_type",
  "too_large",
  "no_text_layer",
  "parse_error"
]);
export const projectSourceRemovalStatusSchema = z
  .object({
    batchId: z.uuid(),
    state: z.enum([
      "preparing",
      "freezing",
      "cancel_requested",
      "ready",
      "complete",
      "cancelled"
    ]),
    complete: z.boolean(),
    retryable: z.boolean(),
    pendingFreezeCount: z.number().int().nonnegative(),
    pendingReviews: z.array(
      z
        .object({
          backendId: z.string().min(1),
          shareGrantId: z.uuid(),
          actionGrantId: z.uuid()
        })
        .strict()
    ),
    cancellationPending: z.boolean()
  })
  .strict();
export const projectSourceRemovalReviewReservationSchema = z
  .object({
    batchId: z.uuid(),
    sourceId: z.uuid(),
    backendId: z.string().min(1),
    shareGrantId: z.uuid(),
    actionGrantId: z.uuid(),
    reviewedGrantVersion: z.number().int().nonnegative()
  })
  .strict();
export const projectSourceSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    kind: projectSourceKindSchema,
    name: z.string().trim().min(1).max(200),
    uri: z.string().trim().min(1).max(2048).nullable(),
    currentRevisionId: z.uuid().nullable(),
    status: projectSourceStatusSchema,
    failureReason: projectSourceFailureSchema.nullable(),
    addedBy: z.uuid(),
    uses: z.number().int().nonnegative(),
    deletedAt: z.iso.datetime({ offset: true }).nullable(),
    createdAt: z.iso.datetime({ offset: true })
  })
  .strict();
export const createProjectSourceSchema = z
  .object({
    kind: projectSourceKindSchema,
    name: z.string().trim().min(1).max(200),
    uri: z.string().trim().min(1).max(2048).nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "folder" &&
      (!value.uri ||
        !/^(\/|[A-Za-z]:[\\/])/.test(value.uri) ||
        value.uri.includes("\0"))
    )
      context.addIssue({
        code: "custom",
        path: ["uri"],
        message: "Folder Source requires an absolute local path"
      });
    if (
      value.kind === "repo" &&
      (!value.uri ||
        !/^[a-z0-9.-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(
          value.uri
        ) ||
        value.uri.includes("..") ||
        value.name !== value.uri)
    )
      context.addIssue({
        code: "custom",
        path: ["uri"],
        message:
          "Repository Source requires a normalized credential-free remote"
      });
  });
export const projectSourcesSchema = z
  .object({ sources: z.array(projectSourceSchema) })
  .strict();
export const projectSourceUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    mediaType: z.string().trim().min(1).max(120),
    bytesBase64: z.string().max(34_952_536),
    idempotencyKey: z.string().trim().min(1).max(512)
  })
  .strict();
export const projectSourceReadSchema = z
  .object({
    sourceId: z.uuid(),
    sourceRevisionId: z.uuid(),
    noteId: z.uuid(),
    noteRevisionId: z.uuid(),
    name: z.string().min(1).max(200),
    text: z.string().max(25 * 1024 * 1024)
  })
  .strict();
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export type CreateProjectSource = z.infer<typeof createProjectSourceSchema>;
