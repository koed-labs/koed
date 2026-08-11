import { z } from "zod";

const forbiddenDisplayContent =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(^|\s)\/\/|(^|[\s(])\/[^\s]*|[A-Za-z]:[\\/]|(^|\s)\\\\|\b(?:authorization|proxy-authorization|bearer|api[-_ ]?(?:key|token)|access[-_ ]?token|refresh[-_ ]?token|secret|password|credential|[a-z0-9-]+-header|x-[a-z0-9-]+)\b|\b(?:token|key|api[_-]?key|api[-_ ]?token)\s*(?:=|:)\s*\S+)/i;

const displayText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        })
    )
    .refine((value) => !forbiddenDisplayContent.test(value));

const version = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);

export const desktopUpdateChannelSchema = z.enum(["stable", "beta"]);

export const desktopUpdateReleaseSchema = z
  .object({
    version,
    channel: desktopUpdateChannelSchema,
    releaseName: displayText(120).optional(),
    releaseNotes: displayText(2_000).optional(),
    publishedAt: z.string().datetime({ offset: true }).optional()
  })
  .strict();

export const desktopUpdateStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("disabled"),
      reason: z.enum(["unpackaged", "unsupported"])
    })
    .strict(),
  z.object({ status: z.literal("idle") }).strict(),
  z.object({ status: z.literal("checking") }).strict(),
  z
    .object({
      status: z.literal("available"),
      release: desktopUpdateReleaseSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("downloading"),
      release: desktopUpdateReleaseSchema,
      progress: z.number().min(0).max(100)
    })
    .strict(),
  z
    .object({
      status: z.literal("ready"),
      release: desktopUpdateReleaseSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("installing"),
      release: desktopUpdateReleaseSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      message: displayText(160),
      release: desktopUpdateReleaseSchema.optional(),
      recoverable: z.boolean().optional()
    })
    .strict()
]);

export const desktopUpdateCommandSchema = z.enum([
  "check",
  "download",
  "install"
]);

export const desktopUpdateVersionSchema = version;

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>;
export type DesktopUpdateRelease = z.infer<typeof desktopUpdateReleaseSchema>;
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export type DesktopUpdateCommand = z.infer<typeof desktopUpdateCommandSchema>;
