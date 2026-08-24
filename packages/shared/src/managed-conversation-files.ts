import { z } from "zod";

export const MANAGED_CONVERSATION_FILE_PROTOCOL_VERSION = 1 as const;
export const MANAGED_CONVERSATION_FILE_MAX_READ_BYTES = 1024 * 1024;

const utf8Encoder = new TextEncoder();
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const safePathComponent = (component: string): boolean =>
  component.length > 0 &&
  component !== "." &&
  component !== ".." &&
  !hasControlCharacter(component) &&
  !component.endsWith(".") &&
  !component.endsWith(" ") &&
  !windowsDeviceName.test(component) &&
  utf8Encoder.encode(component).byteLength <= 255;

const normalizedRelativePath = z
  .string()
  .max(4_096)
  .refine((value) => value === value.normalize("NFC"), "Path must use NFC")
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= 4_096,
    "Path is too long"
  )
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes(":") &&
      (value === "" ||
        value.split("/").every((component) => safePathComponent(component))),
    "Path must be normalized and root-relative"
  );

export const managedConversationFilePathSchema = normalizedRelativePath.refine(
  (value) => value.length > 0,
  "File path is required"
);

export const managedConversationFileRevisionSchema = z
  .object({
    checkpointId: z.uuid(),
    revisionDigest: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

const revisionInput = managedConversationFileRevisionSchema
  .nullable()
  .default(null);

export const managedConversationFileOperationSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("browse"),
        path: normalizedRelativePath.default(""),
        revision: revisionInput,
        offset: z.number().int().safe().nonnegative().default(0),
        limit: z.number().int().safe().min(1).max(500).default(200)
      })
      .strict(),
    z
      .object({
        kind: z.literal("read"),
        path: managedConversationFilePathSchema,
        revision: revisionInput,
        offset: z.number().int().safe().nonnegative().default(0),
        limit: z
          .number()
          .int()
          .safe()
          .min(1)
          .max(MANAGED_CONVERSATION_FILE_MAX_READ_BYTES)
          .default(MANAGED_CONVERSATION_FILE_MAX_READ_BYTES)
      })
      .strict(),
    z
      .object({
        kind: z.literal("search"),
        path: normalizedRelativePath.default(""),
        revision: revisionInput,
        query: z.string().min(1).max(1_024),
        caseSensitive: z.boolean().default(false),
        offset: z.number().int().safe().nonnegative().default(0),
        limit: z.number().int().safe().min(1).max(200).default(100)
      })
      .strict(),
    z
      .object({
        kind: z.literal("mention"),
        path: managedConversationFilePathSchema,
        revision: revisionInput,
        startLine: z.number().int().safe().min(1).max(10_000_000).optional(),
        endLine: z.number().int().safe().min(1).max(10_000_000).optional()
      })
      .strict()
      .refine(
        (value) =>
          (value.startLine === undefined && value.endLine === undefined) ||
          (value.startLine !== undefined &&
            value.endLine !== undefined &&
            value.endLine >= value.startLine &&
            value.endLine - value.startLine < 10_000),
        "Mention line range is invalid"
      )
  ]
);

const resultBase = {
  protocolVersion: z.literal(MANAGED_CONVERSATION_FILE_PROTOCOL_VERSION),
  checkpointId: z.uuid(),
  checkpointSequence: z.number().int().safe().nonnegative(),
  revision: managedConversationFileRevisionSchema
} as const;

export const managedConversationFileOperationResultSchema =
  z.discriminatedUnion("kind", [
    z
      .object({
        ...resultBase,
        kind: z.literal("browse"),
        path: normalizedRelativePath,
        entries: z
          .array(
            z
              .object({
                path: managedConversationFilePathSchema,
                name: z.string().min(1).max(1_024),
                entryKind: z.enum(["file", "directory"]),
                size: z.number().int().safe().nonnegative().nullable(),
                executable: z.boolean()
              })
              .strict()
          )
          .max(500),
        totalEntries: z.number().int().safe().nonnegative(),
        nextOffset: z.number().int().safe().nonnegative().nullable()
      })
      .strict(),
    z
      .object({
        ...resultBase,
        kind: z.literal("read"),
        path: managedConversationFilePathSchema,
        content: z.string().max(MANAGED_CONVERSATION_FILE_MAX_READ_BYTES),
        contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
        totalBytes: z.number().int().safe().nonnegative(),
        offset: z.number().int().safe().nonnegative(),
        nextOffset: z.number().int().safe().nonnegative().nullable(),
        lineCount: z.number().int().safe().nonnegative()
      })
      .strict(),
    z
      .object({
        ...resultBase,
        kind: z.literal("search"),
        path: normalizedRelativePath,
        query: z.string().min(1).max(1_024),
        matches: z
          .array(
            z
              .object({
                path: managedConversationFilePathSchema,
                line: z.number().int().safe().positive(),
                column: z.number().int().safe().positive(),
                preview: z.string().max(4_096),
                contentDigest: z.string().regex(/^[0-9a-f]{64}$/)
              })
              .strict()
          )
          .max(200),
        totalMatches: z.number().int().safe().nonnegative(),
        nextOffset: z.number().int().safe().nonnegative().nullable(),
        scannedFiles: z.number().int().safe().nonnegative(),
        scannedBytes: z.number().int().safe().nonnegative(),
        truncated: z.boolean()
      })
      .strict(),
    z
      .object({
        ...resultBase,
        kind: z.literal("mention"),
        path: managedConversationFilePathSchema,
        contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
        totalBytes: z.number().int().safe().nonnegative(),
        startLine: z.number().int().safe().positive(),
        endLine: z.number().int().safe().positive(),
        selectedBytes: z.number().int().safe().nonnegative(),
        expiresAt: z.iso.datetime()
      })
      .strict()
  ]);

export type ManagedConversationFileRevision = z.infer<
  typeof managedConversationFileRevisionSchema
>;
export type ManagedConversationFileOperation = z.infer<
  typeof managedConversationFileOperationSchema
>;
export type ManagedConversationFileOperationResult = z.infer<
  typeof managedConversationFileOperationResultSchema
>;
