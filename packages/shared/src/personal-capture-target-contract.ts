import { z } from "zod";

const targetId = z.string().min(1).max(8192);
export const personalCaptureTargetBindingSchema = z
  .object({
    origin: z.enum(["legacy_session", "legacy_route"]).optional(),
    bindingId: z.uuid(),
    sessionId: z.uuid(),
    logicalSessionId: z.uuid(),
    version: z.number().int().safe().positive(),
    mode: z.enum(["preserved", "source", "target", "global"]),
    targetId: targetId.nullable(),
    effectiveTargetId: targetId.nullable().optional(),
    originalTarget: z
      .object({
        id: targetId,
        name: z.string().max(512).nullable(),
        path: z.string().max(8192).nullable()
      })
      .strict(),
    legacyDetachedAt: z.iso.datetime({ offset: true }).nullable(),
    repairRequired: z.boolean()
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (
      (binding.mode === "source" || binding.mode === "global") &&
      binding.targetId !== null
    )
      ctx.addIssue({
        code: "custom",
        message: "This Capture Target mode has no fixed target"
      });
    if (
      (binding.mode === "preserved" || binding.mode === "target") &&
      binding.targetId === null
    )
      ctx.addIssue({
        code: "custom",
        message: "This Capture Target mode needs its exact target"
      });
    if (
      binding.mode === "preserved" &&
      binding.targetId !== binding.originalTarget.id
    )
      ctx.addIssue({
        code: "custom",
        message: "The preserved Capture Target changed"
      });
  });
export type PersonalCaptureTargetBinding = z.infer<
  typeof personalCaptureTargetBindingSchema
>;
