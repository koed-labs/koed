import { z } from "zod";

// Only the choices exposed by the Project builder travel in catalog history.
// The Project name labels the Kin and its ID supplies the animation seed.
export const personalProjectKinSchema = z
  .object({
    shape: z.enum(["sphere", "cube", "roundedBox", "capsule"]),
    colour: z.string().regex(/^#[0-9a-f]{6}$/),
    personality: z.enum([
      "neutral",
      "sleepy",
      "grumpy",
      "positive",
      "enthusiastic",
      "joyful",
      "gloomy",
      "mischievous",
      "curious",
      "skittish",
      "indignant"
    ])
  })
  .strict();
export type PersonalProjectKin = z.infer<typeof personalProjectKinSchema>;

export const personalProjectDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kin: personalProjectKinSchema.optional()
  })
  .strict();
