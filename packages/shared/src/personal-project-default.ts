import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import {
  personalProjectSourceTargetSchema,
  personalProjectSourceSelectorKey
} from "./personal-project-source-target.js";
import { personalFolderScopeId } from "./personal-source-contract.js";
import { repositoryScopeId } from "./repository-recall.js";
import { canonicalJsonDeterministicUuid } from "./canonical-json-digest.js";

type Target = z.infer<typeof personalProjectSourceTargetSchema>;
/** The owner is supplied by the authenticated Personal scope. A source key is
 * organization identity only; it never grants source or checkout access. */
export const personalProjectDefaultIdentity = (raw: Target) => {
  const target = personalProjectSourceTargetSchema.parse(raw);
  const sourceKey = `source_default_${bytesToHex(sha256(utf8ToBytes(`koed/personal-project-default/v1\n${personalProjectSourceSelectorKey(target)}`)))}`;
  return {
    sourceKey,
    projectIdentity: canonicalJsonDeterministicUuid({
      namespace: "koed/personal-project-default-project/v1",
      sourceKey
    }),
    sourceScope:
      target.kind === "repository"
        ? repositoryScopeId(target.repository)
        : personalFolderScopeId(target.folder)
  };
};

export const personalProjectDefaultName = (
  target: Target,
  folderPath?: string
): string => {
  const label =
    target.kind === "repository"
      ? (target.repository.anchorDisplay ??
        target.repository.root ??
        "Git Project")
      : (folderPath ?? "Folder Project");
  return (
    label
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/i, "") || "Project"
  ).slice(0, 160);
};
