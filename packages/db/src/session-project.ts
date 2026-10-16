import {
  repositoryScopeId,
  repositoryIdentityMatches,
  type RepositoryIdentity
} from "@koed/shared";
import type { PersonalProjectReference } from "./types.js";

type CapturedProject = {
  id: string | null;
  name: string | null;
  path: string | null;
};

/** Stored capture columns provide display hints, never a second effective identity. */
export const projectFromRepositoryIdentity = (
  identity: RepositoryIdentity | null,
  automatic: RepositoryIdentity | null,
  captured: CapturedProject,
  override?: CapturedProject
): PersonalProjectReference | null => {
  if (!identity || identity.kind === "unresolved") return null;
  const id = repositoryScopeId(identity);
  const followsCapture = repositoryIdentityMatches(automatic, identity);
  return {
    id,
    name:
      (override?.id === id ? override.name : null) ??
      identity.anchorDisplay ??
      (followsCapture ? captured.name : null) ??
      "Project",
    path:
      identity.kind === "local_project"
        ? null
        : (identity.root ?? (followsCapture ? captured.path : null))
  };
};
