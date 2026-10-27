import { z } from "zod";
import { personalProjectSourceTargetSchema } from "./personal-project-source-target.js";
import { personalProjectDefaultIdentity } from "./personal-project-default.js";

/** Monotonic automatic-creation decisions. These never edit User membership or grant access. */
export const personalProjectDefaultDecisionSchema = z
  .object({
    version: z.literal(1),
    sourceKey: z.string().regex(/^source_default_[a-f0-9]{64}$/),
    target: personalProjectSourceTargetSchema,
    state: z.enum(["managed", "retired", "suppressed"])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      personalProjectDefaultIdentity(value.target).sourceKey !== value.sourceKey
    )
      ctx.addIssue({
        code: "custom",
        message: "Default decision does not identify its canonical source"
      });
  });
export type PersonalProjectDefaultDecision = z.infer<
  typeof personalProjectDefaultDecisionSchema
>;
const wire = z
  .object({
    ...personalProjectDefaultDecisionSchema.shape,
    version: z.literal("1")
  })
  .strict();
export const encodePdsPersonalProjectDefaultDecision = (
  raw: PersonalProjectDefaultDecision
) =>
  wire.parse({
    ...personalProjectDefaultDecisionSchema.parse(raw),
    version: "1"
  });
export const decodePdsPersonalProjectDefaultDecision = (
  raw: unknown
): PersonalProjectDefaultDecision => {
  const parsed = wire.parse(raw);
  return personalProjectDefaultDecisionSchema.parse({ ...parsed, version: 1 });
};
export const pdsPersonalProjectDefaultDecisionSchema = wire.superRefine(
  (value, ctx) => {
    try {
      decodePdsPersonalProjectDefaultDecision(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Default decision identity is invalid"
      });
    }
  }
);
