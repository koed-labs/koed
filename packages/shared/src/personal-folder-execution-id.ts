import { canonicalJsonDigest } from "./canonical-json-digest.js";
import {
  personalFolderScopeId,
  type PersonalFolderReference
} from "./personal-source-contract.js";

/** Execution context identity is separate from the named Project catalog. */
export const personalFolderExecutionId = (folder: PersonalFolderReference) =>
  `lf_${canonicalJsonDigest({ namespace: "koed/local-folder-execution/v1", folder: personalFolderScopeId(folder) })}`;
