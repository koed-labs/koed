import { z } from "zod";

export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1)).default([])
});
