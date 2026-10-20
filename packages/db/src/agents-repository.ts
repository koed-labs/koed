import pg from "pg";
import type { Agent, AgentCreate, AgentPatch } from "@koed/shared";
import type { AgentBootstrapContext } from "@koed/shared/agent-contract";

export class AgentInstanceUnavailableError extends Error {}
export class AgentNotFoundError extends Error {}

type Row = Record<string, unknown>;
const present = (row: Row): Agent => ({
  id: String(row.id),
  ownerUserId: String(row.owner_user_id),
  name: String(row.name),
  role: row.role as string | null,
  look: row.look as Agent["look"],
  aiClientInstanceId: String(row.ai_client_instance_id),
  defaultPermissionMode:
    row.default_permission_mode as Agent["defaultPermissionMode"],
  defaultModel: row.default_model as string | null,
  isChiefOfStaff: row.is_chief_of_staff === true,
  createdAt: (row.created_at as Date).toISOString()
});

const fields = `id, owner_user_id, name, role, look, ai_client_instance_id,
  default_permission_mode, default_model, is_chief_of_staff, created_at`;

export const createAgentsRepository = (pool: pg.Pool) => {
  const bootstrapContext = async (
    ownerUserId: string
  ): Promise<AgentBootstrapContext> => {
    // A single statement observes one database snapshot for both owner-owned inputs.
    const result = await pool.query<{
      provider: string | null;
      ai_client_instance_id: string | null;
      enabled_instances: AgentBootstrapContext["enabledInstances"];
    }>(
      `select setting.provider, setting.ai_client_instance_id,
         coalesce((select jsonb_agg(jsonb_build_object(
           'instanceId', instance.instance_id, 'driverId', instance.driver_id
         ) order by instance.instance_id)
         from ai_client_instances instance
         where instance.owner_user_id = $1 and instance.enabled = true), '[]'::jsonb)
         as enabled_instances
       from (select $1::uuid as owner_user_id) owner
       left join local_memory_agent_settings setting
         on setting.owner_user_id = owner.owner_user_id
         and setting.flow_key = 'conversations'`,
      [ownerUserId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Agent bootstrap context did not return a row");
    return {
      ownerUserId,
      savedConversations:
        row.provider && row.ai_client_instance_id
          ? {
              provider: row.provider,
              aiClientInstanceId: row.ai_client_instance_id
            }
          : null,
      enabledInstances: row.enabled_instances
    };
  };
  const list = async (ownerUserId: string): Promise<Agent[]> => {
    const result = await pool.query<Row>(
      `select ${fields} from agents where owner_user_id = $1
       order by is_chief_of_staff desc, created_at asc, id asc`,
      [ownerUserId]
    );
    return result.rows.map(present);
  };

  const withTransaction = async <T>(
    work: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const assertInstance = async (
    client: pg.PoolClient,
    ownerUserId: string,
    instanceId: string
  ) => {
    const result = await client.query(
      `select 1 from ai_client_instances where owner_user_id = $1
       and instance_id = $2 and enabled = true for share`,
      [ownerUserId, instanceId]
    );
    if (!result.rowCount)
      throw new AgentInstanceUnavailableError(
        "AI Client instance is not registered and enabled for this User"
      );
  };

  const ensureChief = async (
    ownerUserId: string,
    instanceId: string
  ): Promise<Agent> =>
    withTransaction(async (client) => {
      const existing = await client.query<Row>(
        `select ${fields} from agents where owner_user_id = $1 and is_chief_of_staff = true`,
        [ownerUserId]
      );
      if (existing.rows[0]) return present(existing.rows[0]);
      await assertInstance(client, ownerUserId, instanceId);
      const inserted = await client.query<Row>(
        `insert into agents (owner_user_id, name, look, ai_client_instance_id,
           default_permission_mode, is_chief_of_staff)
         values ($1, 'Chief of Staff', '{}'::jsonb, $2, 'supervised', true)
         on conflict (owner_user_id) where is_chief_of_staff = true do nothing
         returning ${fields}`,
        [ownerUserId, instanceId]
      );
      if (inserted.rows[0]) return present(inserted.rows[0]);
      const winner = await client.query<Row>(
        `select ${fields} from agents where owner_user_id = $1 and is_chief_of_staff = true`,
        [ownerUserId]
      );
      if (!winner.rows[0])
        throw new Error("Chief of Staff creation did not resolve");
      return present(winner.rows[0]);
    });

  const create = async (
    ownerUserId: string,
    input: AgentCreate
  ): Promise<Agent> =>
    withTransaction(async (client) => {
      await assertInstance(client, ownerUserId, input.aiClientInstanceId);
      const result = await client.query<Row>(
        `insert into agents (owner_user_id, name, role, look, ai_client_instance_id,
          default_permission_mode, default_model)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning ${fields}`,
        [
          ownerUserId,
          input.name,
          input.role,
          JSON.stringify(input.look),
          input.aiClientInstanceId,
          input.defaultPermissionMode,
          input.defaultModel
        ]
      );
      if (!result.rows[0])
        throw new Error("Agent creation did not return a row");
      return present(result.rows[0]);
    });

  const ensureHelpers = async (ownerUserId: string): Promise<Agent[]> =>
    withTransaction(async (client) => {
      const owner = await client.query(
        `select 1 from users where id=$1 for update`,
        [ownerUserId]
      );
      if (!owner.rowCount) throw new AgentNotFoundError("User is unavailable");
      const chief = await client.query<Row>(
        `select ${fields} from agents where owner_user_id=$1 and is_chief_of_staff=true for share`,
        [ownerUserId]
      );
      if (!chief.rows[0])
        throw new AgentNotFoundError("Chief of Staff is unavailable");
      const bound = present(chief.rows[0]);
      await assertInstance(client, ownerUserId, bound.aiClientInstanceId);
      const existing = await client.query<Row>(
        `select ${fields} from agents where owner_user_id=$1 for share`,
        [ownerUserId]
      );
      const names = new Set(
        existing.rows.map((row) => String(row.name).toLocaleLowerCase())
      );
      for (const [name, role] of [
        ["Nova", "Research"],
        ["Quinn", "Builder"],
        ["Sage", "Writing"]
      ] as const) {
        if (names.has(name.toLocaleLowerCase())) continue;
        await client.query(
          `insert into agents (owner_user_id,name,role,look,ai_client_instance_id,
            default_permission_mode,default_model,is_chief_of_staff)
           values ($1,$2,$3,'{}'::jsonb,$4,$5,$6,false)`,
          [
            ownerUserId,
            name,
            role,
            bound.aiClientInstanceId,
            bound.defaultPermissionMode,
            bound.defaultModel
          ]
        );
      }
      const result = await client.query<Row>(
        `select ${fields} from agents where owner_user_id=$1
          order by is_chief_of_staff desc,created_at asc,id asc`,
        [ownerUserId]
      );
      return result.rows.map(present);
    });

  const patch = async (
    ownerUserId: string,
    id: string,
    input: AgentPatch
  ): Promise<Agent> =>
    withTransaction(async (client) => {
      const existing = await client.query<Row>(
        `select ${fields} from agents where owner_user_id = $1 and id = $2 for update`,
        [ownerUserId, id]
      );
      if (!existing.rows[0]) throw new AgentNotFoundError("Agent not found");
      const current = present(existing.rows[0]);
      const next = { ...current, ...input };
      if (next.aiClientInstanceId !== current.aiClientInstanceId)
        await assertInstance(client, ownerUserId, next.aiClientInstanceId);
      const result = await client.query<Row>(
        `update agents set name = $3, role = $4, look = $5::jsonb,
          ai_client_instance_id = $6, default_permission_mode = $7, default_model = $8
         where owner_user_id = $1 and id = $2 returning ${fields}`,
        [
          ownerUserId,
          id,
          next.name,
          next.role,
          JSON.stringify(next.look),
          next.aiClientInstanceId,
          next.defaultPermissionMode,
          next.defaultModel
        ]
      );
      if (!result.rows[0]) throw new Error("Agent update did not return a row");
      return present(result.rows[0]);
    });
  return { bootstrapContext, list, ensureChief, ensureHelpers, create, patch };
};

export type AgentsRepository = ReturnType<typeof createAgentsRepository>;
