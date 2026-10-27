import { z } from "zod";

export const desktopUpdateCommandChannel = "koed:update:command";
export const desktopUpdateEventChannel = "koed:update:state";
export const desktopStableVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const desktopUpdateRequestSchema = z
  .object({
    operation: z.enum(["get_state", "check", "open_release"])
  })
  .strict();

export const desktopUpdateStateSchema = z
  .object({
    installedVersion: z.string().min(1).max(64),
    status: z.enum([
      "disabled",
      "idle",
      "checking",
      "current",
      "available",
      "error"
    ]),
    release: z
      .object({
        version: z.string().max(64).regex(desktopStableVersionPattern),
        summary: z.string().max(4000)
      })
      .strict()
      .nullable(),
    checkedAt: z.iso.datetime().nullable()
  })
  .strict()
  .refine((value) => value.status !== "available" || value.release !== null)
  .refine(
    (value) =>
      !["current", "disabled", "idle"].includes(value.status) ||
      value.release === null
  );

export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;
export type DesktopUpdateRequest = z.infer<typeof desktopUpdateRequestSchema>;
export interface DesktopUpdateApi {
  getState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  openReleasePage(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}
