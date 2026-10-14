import type { MemorySourceRepository } from "@koed/db";
import { personalAgentExecutionContextSchema } from "@koed/shared";

export type PersonalAgentTurnContextResult = {
  expectedAgentVersion: number;
  context: ReturnType<typeof personalAgentExecutionContextSchema.parse>;
};

/** Resolve presentation identity and Project attribution for one chat turn. */
export const buildPersonalAgentTurnContext = async (input: {
  repository: MemorySourceRepository;
  ownerUserId: string;
  agentId: string;
  expectedAgentVersion?: number;
  projectId: string | null;
}): Promise<PersonalAgentTurnContextResult> => {
  const actor = { userId: input.ownerUserId };
  const identity = await input.repository.getPersonalAgentIdentity(
    actor,
    input.agentId
  );
  if (!identity || identity.lifecycle !== "active") {
    throw Object.assign(new Error("Personal Agent is unavailable"), {
      statusCode: 404
    });
  }
  const expectedAgentVersion = identity.currentVersion;
  if (
    input.expectedAgentVersion !== undefined &&
    input.expectedAgentVersion !== expectedAgentVersion
  ) {
    throw Object.assign(
      new Error("Personal Agent changed; reload it before sending"),
      { statusCode: 409 }
    );
  }
  const identityVersion =
    await input.repository.getPersonalAgentPresentationVersion(actor, {
      agentId: input.agentId,
      version: expectedAgentVersion
    });
  if (
    !identityVersion ||
    identityVersion.agentId !== input.agentId ||
    identityVersion.ownerUserId !== input.ownerUserId ||
    identityVersion.version !== expectedAgentVersion
  ) {
    throw Object.assign(new Error("Personal Agent version is unavailable"), {
      statusCode: 404
    });
  }

  let projectName: string | null = null;
  if (input.projectId) {
    const projects = await input.repository.listLcmGraphThreads(actor, {
      projectId: input.projectId,
      limit: 1
    });
    projectName =
      projects.find((candidate) => candidate.id === input.projectId)?.name ??
      null;
  }

  const context = personalAgentExecutionContextSchema.parse({
    schemaVersion: 1,
    identity: {
      agentId: identityVersion.agentId,
      version: identityVersion.version,
      identityVersionId: identityVersion.id,
      name: identityVersion.name,
      role: identityVersion.role,
      avatarReference: identityVersion.avatarReference
    },
    project: {
      projectId: input.projectId,
      name: projectName
    }
  });

  return { expectedAgentVersion, context };
};
