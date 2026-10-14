import {
  repositoryIdentitySchema,
  type RepositoryIdentity
} from "./repository-identity.js";

export const repositoryRecallContextSchema = repositoryIdentitySchema.refine(
  (identity) => identity.kind !== "unresolved" && identity.key !== null,
  "Project recall requires a resolved repository identity"
);
export const repositoryScopeId = (identity: RepositoryIdentity): string => {
  const resolved = repositoryRecallContextSchema.parse(identity);
  return `repository:${JSON.stringify({ kind: resolved.kind, key: resolved.key, device: resolved.kind === "portable_repository" ? null : resolved.originatingDeviceId })}`;
};
export const repositoryIdentityMatches = (
  left: RepositoryIdentity | null,
  right: RepositoryIdentity
): boolean =>
  Boolean(
    left &&
    left.kind !== "unresolved" &&
    left.kind === right.kind &&
    left.key !== null &&
    left.key === right.key &&
    (left.kind === "portable_repository" ||
      left.originatingDeviceId === right.originatingDeviceId)
  );
