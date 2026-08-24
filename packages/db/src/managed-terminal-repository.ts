import { createHash, randomUUID } from "node:crypto";

import type {
  CreateManagedTerminalInput,
  ManagedTerminalLifecycleState,
  ManagedTerminalRecord
} from "@koed/shared";
import { createManagedTerminalInputSchema } from "@koed/shared";
import pg from "pg";

import type { ActorContext } from "./types.js";

const activeStates = [
  "creating",
  "running",
  "detached",
  "stopping",
  "unknown"
] as const;

type TerminalRow = {
  id: string;
  owner_user_id: string;
  execution_id: string;
  execution_generation: number;
  workspace_id: string;
  runner_deployment_id: string;
  runner_device_id: string;
  lifecycle_generation: number;
  shell_profile_id: "system_default";
  state: ManagedTerminalLifecycleState;
  columns: number;
  rows: number;
  idempotency_key: string;
  request_digest: string;
  exit_code: number | null;
  exit_signal: number | null;
  failure_code: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  detached_at: Date | string | null;
  stopped_at: Date | string | null;
  updated_at: Date | string;
};

const terminalColumns = `
  id, owner_user_id, execution_id, execution_generation, workspace_id,
  runner_deployment_id, runner_device_id, lifecycle_generation,
  shell_profile_id, state, columns, rows, idempotency_key, request_digest,
  exit_code, exit_signal, failure_code, created_at, started_at, detached_at,
  stopped_at, updated_at
`;

const iso = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;
const requiredIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;
const mapTerminal = (row: TerminalRow): ManagedTerminalRecord => ({
  id: row.id,
  executionId: row.execution_id,
  executionGeneration: row.execution_generation,
  workspaceId: row.workspace_id,
  runnerDeploymentId: row.runner_deployment_id,
  runnerDeviceId: row.runner_device_id,
  lifecycleGeneration: row.lifecycle_generation,
  shellProfileId: row.shell_profile_id,
  state: row.state,
  columns: row.columns,
  rows: row.rows,
  exitCode: row.exit_code,
  exitSignal: row.exit_signal,
  failureCode: row.failure_code,
  createdAt: requiredIso(row.created_at),
  startedAt: iso(row.started_at),
  detachedAt: iso(row.detached_at),
  stoppedAt: iso(row.stopped_at),
  updatedAt: requiredIso(row.updated_at)
});

const statusError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const requestDigestFor = (input: CreateManagedTerminalInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        executionGeneration: input.executionGeneration,
        shellProfileId: input.shellProfileId,
        columns: input.columns,
        rows: input.rows
      })
    )
    .digest("hex");

export interface ManagedTerminalRepository {
  createManagedTerminal(
    actor: ActorContext,
    input: CreateManagedTerminalInput & { executionId: string }
  ): Promise<ManagedTerminalRecord>;
  listManagedTerminals(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedTerminalRecord[]>;
  getManagedTerminal(
    actor: ActorContext,
    input: { executionId: string; terminalId: string }
  ): Promise<ManagedTerminalRecord | null>;
  transitionManagedTerminal(input: {
    ownerUserId: string;
    terminalId: string;
    executionGeneration: number;
    lifecycleGeneration: number;
    runnerDeploymentId: string;
    runnerDeviceId: string;
    fromStates: ManagedTerminalLifecycleState[];
    state: ManagedTerminalLifecycleState;
    columns?: number;
    rows?: number;
    exitCode?: number | null;
    exitSignal?: number | null;
    failureCode?: string | null;
  }): Promise<ManagedTerminalRecord | null>;
  reconcileManagedTerminalsForRunner(input: {
    runnerDeploymentId: string;
    runnerDeviceId: string;
    failureCode: string;
  }): Promise<number>;
}

export const createManagedTerminalRepository = (
  pool: pg.Pool
): ManagedTerminalRepository => ({
  async createManagedTerminal(actor, input) {
    const { executionId, ...terminalInput } = input;
    const validated = createManagedTerminalInputSchema.parse(terminalInput);
    const digest = requestDigestFor(validated);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`managed-terminal:${actor.userId}:${executionId}`]
      );
      const existing = await client.query<TerminalRow>(
        `select ${terminalColumns}
           from managed_conversation_terminals
          where owner_user_id = $1
            and execution_id = $2
            and idempotency_key = $3`,
        [actor.userId, executionId, validated.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== digest) {
          throw statusError("Terminal idempotency key was reused", 409);
        }
        await client.query("commit");
        return mapTerminal(existing.rows[0]);
      }
      const binding = await client.query<{
        execution_generation: number;
        runner_deployment_id: string;
        runner_device_id: string;
        execution_state: string;
        binding_deployment_id: string;
        binding_device_id: string;
        binding_generation: number;
        workspace_id: string | null;
        workspace_lifecycle: string;
      }>(
        `select execution.execution_generation,
                execution.runner_deployment_id,
                execution.runner_device_id,
                execution.state as execution_state,
                binding.deployment_id as binding_deployment_id,
                binding.device_id as binding_device_id,
                binding.execution_generation as binding_generation,
                binding.workspace_id,
                binding.workspace_lifecycle
           from managed_conversation_executions execution
           join managed_conversation_runtime_bindings binding
             on binding.execution_id = execution.id
            and binding.owner_user_id = execution.owner_user_id
          where execution.id = $1 and execution.owner_user_id = $2
          for update of execution, binding`,
        [executionId, actor.userId]
      );
      const row = binding.rows[0];
      if (!row) throw statusError("Managed Conversation was not found", 404);
      if (
        row.execution_generation !== validated.executionGeneration ||
        row.binding_generation !== validated.executionGeneration ||
        row.binding_deployment_id !== row.runner_deployment_id ||
        row.binding_device_id !== row.runner_device_id
      ) {
        throw statusError("Terminal execution authority is stale", 409);
      }
      if (
        row.workspace_lifecycle !== "ready" ||
        !row.workspace_id ||
        !["starting", "running", "reconciling", "quiesced"].includes(
          row.execution_state
        )
      ) {
        throw statusError("Terminal workspace is not ready", 409);
      }
      const active = await client.query<{ count: string }>(
        `select count(*)::text as count
           from managed_conversation_terminals
          where owner_user_id = $1 and execution_id = $2
            and state = any($3::text[])`,
        [actor.userId, executionId, activeStates]
      );
      if (Number(active.rows[0]?.count ?? 0) >= 8) {
        throw statusError("Terminal limit reached", 409);
      }
      const created = await client.query<TerminalRow>(
        `insert into managed_conversation_terminals (
           id, owner_user_id, execution_id, execution_generation, workspace_id,
           runner_deployment_id, runner_device_id, shell_profile_id, state,
           columns, rows, idempotency_key, request_digest
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'creating', $9, $10, $11, $12)
         returning ${terminalColumns}`,
        [
          randomUUID(),
          actor.userId,
          executionId,
          validated.executionGeneration,
          row.workspace_id,
          row.runner_deployment_id,
          row.runner_device_id,
          validated.shellProfileId,
          validated.columns,
          validated.rows,
          validated.idempotencyKey,
          digest
        ]
      );
      await client.query("commit");
      return mapTerminal(created.rows[0]!);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async listManagedTerminals(actor, executionId) {
    const result = await pool.query<TerminalRow>(
      `select ${terminalColumns}
         from managed_conversation_terminals
        where owner_user_id = $1 and execution_id = $2
        order by created_at asc, id asc`,
      [actor.userId, executionId]
    );
    return result.rows.map(mapTerminal);
  },

  async getManagedTerminal(actor, input) {
    const result = await pool.query<TerminalRow>(
      `select ${terminalColumns}
         from managed_conversation_terminals
        where owner_user_id = $1 and execution_id = $2 and id = $3`,
      [actor.userId, input.executionId, input.terminalId]
    );
    return result.rows[0] ? mapTerminal(result.rows[0]) : null;
  },

  async transitionManagedTerminal(input) {
    const result = await pool.query<TerminalRow>(
      `update managed_conversation_terminals
          set state = $8,
              columns = coalesce($9, columns),
              rows = coalesce($10, rows),
              exit_code = $11,
              exit_signal = $12,
              failure_code = $13,
              started_at = case when $8 = 'running' then coalesce(started_at, now()) else started_at end,
              detached_at = case when $8 = 'detached' then now() when $8 = 'running' then null else detached_at end,
              stopped_at = case when $8 in ('exited', 'failed') then now() else stopped_at end,
              updated_at = now()
        where owner_user_id = $1
          and id = $2
          and execution_generation = $3
          and lifecycle_generation = $4
          and runner_deployment_id = $5
          and runner_device_id = $6
          and state = any($7::text[])
        returning ${terminalColumns}`,
      [
        input.ownerUserId,
        input.terminalId,
        input.executionGeneration,
        input.lifecycleGeneration,
        input.runnerDeploymentId,
        input.runnerDeviceId,
        input.fromStates,
        input.state,
        input.columns ?? null,
        input.rows ?? null,
        input.exitCode ?? null,
        input.exitSignal ?? null,
        input.failureCode ?? null
      ]
    );
    return result.rows[0] ? mapTerminal(result.rows[0]) : null;
  },

  async reconcileManagedTerminalsForRunner(input) {
    const result = await pool.query(
      `update managed_conversation_terminals
          set state = case when state = 'creating' then 'failed' else 'unknown' end,
              failure_code = $3,
              stopped_at = case when state = 'creating' then now() else stopped_at end,
              updated_at = now()
        where runner_deployment_id = $1
          and runner_device_id = $2
          and state in ('creating', 'running', 'detached', 'stopping')`,
      [input.runnerDeploymentId, input.runnerDeviceId, input.failureCode]
    );
    return result.rowCount ?? 0;
  }
});
