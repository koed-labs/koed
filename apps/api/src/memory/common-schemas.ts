import { z } from "zod";

export const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

export const visibilitySchema = z.literal("personal");
