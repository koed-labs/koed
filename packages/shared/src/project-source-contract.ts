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
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export type CreateProjectSource = z.infer<typeof createProjectSourceSchema>;
