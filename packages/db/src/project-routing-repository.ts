import type { RepositoryIdentity } from "@koed/shared";
import type { ActorContext, PersonalProjectReference } from "./types.js";

type ProjectTarget = PersonalProjectReference & {
  repositoryIdentity: RepositoryIdentity;
};

export interface ProjectRoutingRepository {
  resolveProjectRouting(
    actor: ActorContext,
    sourceProjectId: string
  ): Promise<ProjectTarget | null>;
}

/** Retained read contract for clients that still inspect retired Project routes. */
export const createProjectRoutingRepository = (): ProjectRoutingRepository => ({
  resolveProjectRouting: () => Promise.resolve(null)
});
