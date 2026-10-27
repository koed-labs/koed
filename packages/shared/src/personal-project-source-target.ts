import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  personalGitContextSchema,
  personalFolderReferenceSchema
} from "./personal-source-contract.js";
import { repositoryScopeId } from "./repository-recall.js";

export const personalProjectSourceTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      repository: personalGitContextSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("folder"),
      folder: personalFolderReferenceSchema
    })
    .strict()
]);
/** Portable organization identity excludes receiving owner aliases and checkout display metadata. */
export const personalProjectSourceSelectorKey = (
  raw: z.infer<typeof personalProjectSourceTargetSchema>
): string => {
  const target = personalProjectSourceTargetSchema.parse(raw);
  if (target.kind === "repository")
    return canonicalJsonStringify({
      kind: "repository",
      scope: repositoryScopeId(target.repository)
    });
  const { ownerUserId, ...reference } = target.folder;
  void ownerUserId;
  return canonicalJsonStringify({ kind: "folder", reference });
};
