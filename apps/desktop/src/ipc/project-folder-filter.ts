import { z } from "zod";

export const projectFolderFilterSchema = z
  .object({
    projectId: z.string().min(1).max(8192),
    hiddenFolderIds: z.array(z.string().min(1).max(8192)).max(512)
  })
  .strict();
export const projectFolderFilterGetSchema = projectFolderFilterSchema.pick({
  projectId: true
});
export type ProjectFolderFilter = z.infer<typeof projectFolderFilterSchema>;
