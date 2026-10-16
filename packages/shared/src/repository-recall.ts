import { z } from "zod";
import {
  repositoryIdentitySchema,
  type RepositoryIdentity
} from "./repository-identity.js";

export const repositoryRecallContextSchema = z.union(
  [
    repositoryIdentitySchema.options[0],
    repositoryIdentitySchema.options[1],
    repositoryIdentitySchema.options[2],
    repositoryIdentitySchema.options[3]
  ],
  { error: "Project recall requires a resolved repository identity" }
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
    left.key === right.key &&
    (left.kind === "portable_repository" ||
      left.originatingDeviceId === right.originatingDeviceId)
  );

/** Pure retrieval policy; authorization and evidence disclosure stay with the caller. */
export const planRepositorySearch = (input: {
  retrievalScope: string;
  searchDomain: string;
  repositoryContext?: RepositoryIdentity | null;
  retrievalStage?: string;
  limit: number;
  candidateLimit?: number;
  maxSearchPasses?: 1 | 2;
}): { global: number; current: number; searchPasses: 1 | 2 } => {
  const limit = input.candidateLimit ?? input.limit;
  const context = input.repositoryContext;
  const enabled =
    input.searchDomain === "global" &&
    input.retrievalStage !== "score_scan" &&
    input.limit > 1 &&
    input.maxSearchPasses !== 1 &&
    context != null &&
    context.kind !== "unresolved" &&
    (input.retrievalScope === "personal" ||
      (input.retrievalScope === "team" &&
        context.kind === "portable_repository"));
  const current = enabled && limit > 1 ? Math.max(1, Math.floor(limit / 4)) : 0;
  return {
    global: limit - current,
    current,
    searchPasses: current > 0 ? 2 : 1
  };
};
