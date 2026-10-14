import pg from "pg";
import type { ActorContext } from "./types.js";

export interface RegisterNativePublicSquareWorkInput {
  commandId: string;
  executionId: string;
  executionGeneration: number;
  agentId: string;
  agentVersion: number;
  originalProjectId: string | null;
}

export interface PublishNativePublicSquareWorkForConnectionInput {
  teamId: string;
  teamProjectId: string;
  connectionId: string;
  localProjectId: string;
}

type QueryClient = pg.Pool | pg.PoolClient;

const activeStatuses = "('queued','running','waiting','offline','unknown')";

const publishWorkForConnection = async (
  client: QueryClient,
  input: PublishNativePublicSquareWorkForConnectionInput & {
    ownerUserId: string;
  }
): Promise<string[]> => {
  const connection = await client.query(
    `select 1
       from public_square_project_connections c
       join collaboration_team_shared_projects sp
         on sp.id=c.team_project_id and sp.team_id=c.team_id and sp.unshared_at is null
       join team_memberships membership
         on membership.team_id=c.team_id and membership.user_id=c.actor_user_id
        and membership.status='enabled' and membership.disabled_at is null
      where c.id=$1 and c.actor_user_id=$2 and c.team_id=$3
        and c.team_project_id=$4 and c.local_project_id=$5
      for share of c,sp,membership`,
    [
      input.connectionId,
      input.ownerUserId,
      input.teamId,
      input.teamProjectId,
      input.localProjectId
    ]
  );
  if (connection.rowCount !== 1) return [];

  const published = await client.query<{ id: string }>(
    `insert into personal_agent_team_native_command_publications
       (team_id,team_project_id,owner_user_id,work_id,connection_id)
     select $1,$2,w.owner_user_id,w.id,$3
       from personal_agent_native_public_square_work w
       join managed_conversation_commands c
         on c.id=w.command_id and c.execution_id=w.execution_id
        and c.owner_user_id=w.owner_user_id
       join managed_conversation_executions e
         on e.id=w.execution_id and e.owner_user_id=w.owner_user_id
      where w.owner_user_id=$4
        and w.original_project_id=$5
        and native_public_square_command_status(
          w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
        ) in ${activeStatuses}
      on conflict (connection_id,work_id) do nothing
      returning id`,
    [
      input.teamId,
      input.teamProjectId,
      input.connectionId,
      input.ownerUserId,
      input.localProjectId
    ]
  );
  return published.rows.map((row) => row.id);
};

export const registerNativePublicSquareWorkWithClient = async (
  client: QueryClient,
  actor: ActorContext,
  input: RegisterNativePublicSquareWorkInput
): Promise<{ workId: string; publicationIds: string[] }> => {
  if (input.executionGeneration < 1 || input.agentVersion < 1)
    throw new Error("Invalid native Public Square context");
  if (
    input.originalProjectId !== null &&
    (input.originalProjectId.trim().length < 1 ||
      input.originalProjectId.trim().length > 512)
  ) {
    throw new Error("Invalid native Public Square Project context");
  }

  const authority = await client.query<{ id: string }>(
    `select c.id
       from managed_conversation_commands c
       join managed_conversation_executions e
         on e.id=c.execution_id and e.owner_user_id=c.owner_user_id
       join personal_agent_identity_versions v
         on v.owner_user_id=$1 and v.agent_id=$5 and v.version=$6
      where c.id=$2 and c.execution_id=$3 and c.owner_user_id=$1
        and c.command_kind='prompt'
        and c.execution_generation=$4
        and e.execution_generation=$4`,
    [
      actor.userId,
      input.commandId,
      input.executionId,
      input.executionGeneration,
      input.agentId,
      input.agentVersion
    ]
  );
  if (authority.rowCount !== 1)
    throw new Error(
      "Native Public Square source is not an authorized Agent prompt"
    );

  const inserted = await client.query<{ id: string }>(
    `insert into personal_agent_native_public_square_work
       (owner_user_id,execution_id,command_id,execution_generation,agent_id,
        agent_version,original_project_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (owner_user_id,command_id) do nothing
     returning id`,
    [
      actor.userId,
      input.executionId,
      input.commandId,
      input.executionGeneration,
      input.agentId,
      input.agentVersion,
      input.originalProjectId
    ]
  );
  let workId = inserted.rows[0]?.id;
  if (!workId) {
    const existing = await client.query<{
      id: string;
      execution_id: string;
      execution_generation: number;
      agent_id: string;
      agent_version: number;
      original_project_id: string | null;
    }>(
      `select id,execution_id,execution_generation,agent_id,agent_version,original_project_id
         from personal_agent_native_public_square_work
        where owner_user_id=$1 and command_id=$2`,
      [actor.userId, input.commandId]
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.execution_id !== input.executionId ||
      row.execution_generation !== input.executionGeneration ||
      row.agent_id !== input.agentId ||
      row.agent_version !== input.agentVersion ||
      row.original_project_id !== input.originalProjectId
    ) {
      throw new Error("Native Public Square source binding changed");
    }
    workId = row.id;
  }

  const connections = await client.query<{
    team_id: string;
    team_project_id: string;
    connection_id: string;
    local_project_id: string;
  }>(
    `select c.team_id,c.team_project_id,c.id as connection_id,
            c.local_project_id
       from public_square_project_connections c
       join collaboration_team_shared_projects sp
         on sp.id=c.team_project_id and sp.team_id=c.team_id and sp.unshared_at is null
       join team_memberships membership
         on membership.team_id=c.team_id and membership.user_id=c.actor_user_id
        and membership.status='enabled' and membership.disabled_at is null
      where c.actor_user_id=$1 and c.local_project_id=$2
      for share of c,sp,membership`,
    [actor.userId, input.originalProjectId]
  );
  const publicationIds: string[] = [];
  for (const connection of connections.rows) {
    publicationIds.push(
      ...(await publishWorkForConnection(client, {
        teamId: connection.team_id,
        teamProjectId: connection.team_project_id,
        connectionId: connection.connection_id,
        localProjectId: connection.local_project_id,
        ownerUserId: actor.userId
      }))
    );
  }
  return { workId, publicationIds };
};

export const publishNativePublicSquareWorkForConnectionWithClient = async (
  client: QueryClient,
  actor: ActorContext,
  input: PublishNativePublicSquareWorkForConnectionInput
): Promise<string[]> =>
  publishWorkForConnection(client, {
    ...input,
    ownerUserId: actor.userId
  });
