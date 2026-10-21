import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import { decryptAuthorizedEncryptedFieldPayloadWithClient } from "./encrypted-payload-repository.js";

export type ManagedMemoryActionKind = "forget" | "correct";
export type ManagedMemoryActionResult = {
  outcome:
    | "forgotten"
    | "proposal_created"
    | "offer_chat_forget"
    | "ask_owner"
    | "ask_reference"
    | "unavailable"
    | "undone";
  message: string;
  assertionId?: string;
  suppressionToken?: string;
  proposalId?: string;
  citationAlias?: string;
  sourceSessionId?: string;
};

export interface ManagedMemoryActionRecord {
  id: string;
  ownerUserId: string;
  logicalSessionId: string;
  executionId: string;
  commandId: string;
  executionGeneration: number;
  providerTurnId: string;
  toolCallId: string;
  actionKind: ManagedMemoryActionKind;
  state: "pending" | "completed" | "rejected";
  request: {
    userPrompt: string;
    requestedAlias?: string;
    reference?: string;
    correction?: string;
    userStatement?: string;
  };
  result: ManagedMemoryActionResult | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ManagedMemoryActionRepository {
  enqueueManagedMemoryAction(
    actor: ActorContext,
    input: {
      executionId: string;
      commandId: string;
      leaseToken: string;
      executionGeneration: number;
      providerTurnId: string;
      toolCallId: string;
      actionKind: ManagedMemoryActionKind;
      request: ManagedMemoryActionRecord["request"];
    }
  ): Promise<ManagedMemoryActionRecord | null>;
  listManagedMemoryActionsForCommand(
    actor: ActorContext,
    commandId: string
  ): Promise<ManagedMemoryActionRecord[]>;
  listManagedMemoryActionResults(
    actor: ActorContext,
    executionId: string
  ): Promise<ManagedMemoryActionRecord[]>;
  undoManagedMemoryAction(
    actor: ActorContext,
    input: { actionId: string; executionId: string },
    unsuppress: (
      assertionId: string,
      suppressionToken: string
    ) => Promise<unknown>
  ): Promise<ManagedMemoryActionRecord | null>;
  countManagedMemoryActionsForRewrap(input?: {
    ownerUserId?: string;
    sourceColumn?: "encrypted_request" | "encrypted_result";
  }): Promise<number>;
  withManagedMemoryActionLease(
    actor: ActorContext,
    input: { actionId: string; commandId: string; leaseToken: string },
    process: (
      action: ManagedMemoryActionRecord,
      authority: { localSessionId: string; clientUserMessageId: string }
    ) => Promise<ManagedMemoryActionResult>
  ): Promise<ManagedMemoryActionRecord | null>;
  getManagedMemoryActionUserSource(
    actor: ActorContext,
    input: {
      commandId: string;
      clientUserMessageId: string;
      localSessionId: string;
    }
  ): Promise<string | null>;
  bindManagedMemoryActionUserSource(
    actor: ActorContext,
    input: {
      commandId: string;
      executionId: string;
      executionGeneration: number;
      leaseToken: string;
      localSessionId: string;
      clientUserMessageId: string;
      sourceKind: "pi" | "claude-code";
      externalSessionId: string;
      sourceGenerationId: string;
      fromLine: number;
      toLine: number;
      providerPrompt: string;
    }
  ): Promise<string | null>;
  findManagedMemoryCorrectionProposal(
    actor: ActorContext,
    actionId: string
  ): Promise<string | null>;
  resolveManagedMemorySourceSession(
    actor: ActorContext,
    input: {
      sourceType: "memory_node" | "memory_event" | "message";
      sourceId: string;
    }
  ): Promise<string | null>;
  rewrapManagedMemoryActionBatch(
    provider: EnvelopeEncryptionProvider,
    input?: {
      ownerUserId?: string;
      batchSize?: number;
      afterId?: string;
      dryRun?: boolean;
      force?: boolean;
      sourceColumn?: "encrypted_request" | "encrypted_result";
    }
  ): Promise<{
    processedRows: number;
    rewrappedRows: number;
    done: boolean;
    nextCursorId: string | null;
  }>;
}

type ActionRow = {
  id: string;
  owner_user_id: string;
  logical_session_id: string;
  execution_id: string;
  command_id: string;
  execution_generation: number;
  provider_turn_id: string;
  tool_call_id: string;
  action_kind: ManagedMemoryActionKind;
  request_digest: string;
  encrypted_request: EncryptedPayloadEnvelope;
  state: ManagedMemoryActionRecord["state"];
  encrypted_result: EncryptedPayloadEnvelope | null;
  created_at: Date;
  completed_at: Date | null;
};

const requestDigest = (request: ManagedMemoryActionRecord["request"]): string =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");
const route = (row: ActionRow) =>
  JSON.stringify({
    ownerUserId: row.owner_user_id,
    logicalSessionId: row.logical_session_id,
    executionId: row.execution_id,
    commandId: row.command_id,
    executionGeneration: row.execution_generation,
    providerTurnId: row.provider_turn_id,
    toolCallId: row.tool_call_id,
    actionKind: row.action_kind,
    requestDigest: row.request_digest
  });

const envelopeFor = async (
  provider: EnvelopeEncryptionProvider,
  row: ActionRow,
  field: "request" | "result",
  value: unknown
): Promise<EncryptedPayloadEnvelope> =>
  provider.encrypt({
    plaintext: JSON.stringify(value),
    scope: {
      tenantId: row.owner_user_id,
      objectClass: "managed_conversation_memory_action"
    },
    provenance: {
      rowFamily: "managed_conversation_memory_actions",
      sourceId: row.id
    },
    ciphertextLocation: `managed_conversation_memory_actions.encrypted_${field}`,
    aad: {
      ownerUserId: row.owner_user_id,
      executionId: row.execution_id,
      commandId: row.command_id,
      actionId: row.id,
      field,
      routingIdentityJson: route(row)
    }
  });

const verifyEnvelope = (
  row: ActionRow,
  field: "request" | "result",
  envelope: EncryptedPayloadEnvelope
): void => {
  if (
    envelope.scope?.tenantId !== row.owner_user_id ||
    envelope.scope?.objectClass !== "managed_conversation_memory_action" ||
    envelope.provenance?.rowFamily !== "managed_conversation_memory_actions" ||
    envelope.provenance?.sourceId !== row.id ||
    envelope.ciphertextLocation !==
      `managed_conversation_memory_actions.encrypted_${field}` ||
    envelope.aad?.ownerUserId !== row.owner_user_id ||
    envelope.aad?.executionId !== row.execution_id ||
    envelope.aad?.commandId !== row.command_id ||
    envelope.aad?.actionId !== row.id ||
    envelope.aad?.field !== field ||
    envelope.aad?.routingIdentityJson !== route(row)
  )
    throw new Error("Managed memory action encrypted custody mismatch");
};

const present = async (
  provider: EnvelopeEncryptionProvider,
  row: ActionRow
): Promise<ManagedMemoryActionRecord> => {
  verifyEnvelope(row, "request", row.encrypted_request);
  const request = JSON.parse(
    await decryptEnvelopeToUtf8(provider, row.encrypted_request)
  ) as ManagedMemoryActionRecord["request"];
  if (requestDigest(request) !== row.request_digest)
    throw new Error("Managed memory action request digest mismatch");
  let result: ManagedMemoryActionResult | null = null;
  if (row.encrypted_result) {
    verifyEnvelope(row, "result", row.encrypted_result);
    result = JSON.parse(
      await decryptEnvelopeToUtf8(provider, row.encrypted_result)
    ) as ManagedMemoryActionResult;
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    logicalSessionId: row.logical_session_id,
    executionId: row.execution_id,
    commandId: row.command_id,
    executionGeneration: row.execution_generation,
    providerTurnId: row.provider_turn_id,
    toolCallId: row.tool_call_id,
    actionKind: row.action_kind,
    state: row.state,
    request,
    result,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null
  };
};

export const createManagedMemoryActionRepository = (
  pool: pg.Pool,
  encryptionProvider?: EnvelopeEncryptionProvider
): ManagedMemoryActionRepository => {
  const provider = new Proxy({} as EnvelopeEncryptionProvider, {
    get(_target, property) {
      if (!encryptionProvider)
        throw new Error("Managed memory actions require envelope encryption");
      const value: unknown = Reflect.get(
        encryptionProvider,
        property,
        encryptionProvider
      );
      return typeof value === "function"
        ? (...args: unknown[]): unknown =>
            Reflect.apply(value, encryptionProvider, args) as unknown
        : value;
    }
  });
  return {
    async enqueueManagedMemoryAction(actor, input) {
      const id = randomUUID();
      const digest = requestDigest(input.request);
      const row: ActionRow = {
        id,
        owner_user_id: actor.userId,
        logical_session_id: "",
        execution_id: input.executionId,
        command_id: input.commandId,
        execution_generation: input.executionGeneration,
        provider_turn_id: input.providerTurnId,
        tool_call_id: input.toolCallId,
        action_kind: input.actionKind,
        request_digest: digest,
        encrypted_request: null as never,
        encrypted_result: null,
        state: "pending",
        created_at: new Date(),
        completed_at: null
      };
      const authority = await pool.query<{ logical_session_id: string }>(
        `select execution.logical_session_id
         from managed_conversation_commands command
         join managed_conversation_executions execution
           on execution.id=command.execution_id
          and execution.owner_user_id=command.owner_user_id
         join managed_conversation_runtime_bindings binding
           on binding.execution_id=execution.id
          and binding.owner_user_id=execution.owner_user_id
          and binding.execution_generation=execution.execution_generation
         join sessions session
           on session.id=binding.local_session_id
          and session.logical_session_id=execution.logical_session_id
          and session.owner_user_id=execution.owner_user_id
        where command.id=$1 and command.owner_user_id=$2
          and command.execution_id=$3 and command.execution_generation=$4
          and command.lease_token=$5 and command.state='dispatching'
          and command.lease_expires_at>now()
          and execution.execution_generation=$4
          and execution.state in ('running','reconciling')
          and execution.runner_lease_expires_at>now()
          and session.personal_deleted_at is null and session.trashed_at is null
        limit 1`,
        [
          input.commandId,
          actor.userId,
          input.executionId,
          input.executionGeneration,
          input.leaseToken
        ]
      );
      if (!authority.rows[0]?.logical_session_id) return null;
      row.logical_session_id = authority.rows[0].logical_session_id;
      row.encrypted_request = await envelopeFor(
        provider,
        row,
        "request",
        input.request
      );
      const inserted = await pool.query<ActionRow>(
        `insert into managed_conversation_memory_actions
         (id,owner_user_id,logical_session_id,execution_id,command_id,
          execution_generation,provider_turn_id,tool_call_id,action_kind,
          request_digest,encrypted_request)
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb
       where exists (
         select 1 from managed_conversation_commands command
         join managed_conversation_executions execution
           on execution.id=command.execution_id
          and execution.owner_user_id=command.owner_user_id
         where command.id=$5 and command.owner_user_id=$2
           and command.execution_id=$4 and command.execution_generation=$6
           and command.lease_token=$12 and command.state='dispatching'
           and command.lease_expires_at>now()
           and execution.execution_generation=$6
           and execution.runner_lease_expires_at>now()
       )
       on conflict on constraint managed_memory_actions_tool_call_unique
         do nothing
       returning *`,
        [
          id,
          actor.userId,
          row.logical_session_id,
          input.executionId,
          input.commandId,
          input.executionGeneration,
          input.providerTurnId,
          input.toolCallId,
          input.actionKind,
          digest,
          JSON.stringify(row.encrypted_request),
          input.leaseToken
        ]
      );
      if (inserted.rows[0]) return present(provider, inserted.rows[0]);
      const existing = await pool.query<ActionRow>(
        `select * from managed_conversation_memory_actions
        where owner_user_id=$1 and execution_id=$2 and command_id=$3
          and provider_turn_id=$4 and tool_call_id=$5`,
        [
          actor.userId,
          input.executionId,
          input.commandId,
          input.providerTurnId,
          input.toolCallId
        ]
      );
      if (
        !existing.rows[0] ||
        existing.rows[0].request_digest !== digest ||
        existing.rows[0].action_kind !== input.actionKind
      )
        return null;
      return present(provider, existing.rows[0]);
    },

    async listManagedMemoryActionsForCommand(actor, commandId) {
      const rows = await pool.query<ActionRow>(
        `select action.* from managed_conversation_memory_actions action
         join managed_conversation_commands command
           on command.id=action.command_id
          and command.owner_user_id=action.owner_user_id
        where action.owner_user_id=$1 and action.command_id=$2
          and command.execution_id=action.execution_id
          and command.execution_generation=action.execution_generation
        order by action.created_at,action.id`,
        [actor.userId, commandId]
      );
      return Promise.all(rows.rows.map((row) => present(provider, row)));
    },

    async listManagedMemoryActionResults(actor, executionId) {
      const rows = await pool.query<ActionRow>(
        `select action.* from managed_conversation_memory_actions action
         join managed_conversation_executions execution
           on execution.id=action.execution_id
          and execution.owner_user_id=action.owner_user_id
         join managed_conversation_runtime_bindings binding
           on binding.execution_id=execution.id
          and binding.owner_user_id=execution.owner_user_id
          and binding.execution_generation=action.execution_generation
         join sessions session
           on session.id=binding.local_session_id
          and session.logical_session_id=action.logical_session_id
          and session.owner_user_id=action.owner_user_id
        where action.owner_user_id=$1 and action.execution_id=$2
          and session.personal_deleted_at is null and session.trashed_at is null
        order by action.created_at desc,action.id desc limit 100`,
        [actor.userId, executionId]
      );
      return Promise.all(rows.rows.map((row) => present(provider, row)));
    },

    async undoManagedMemoryAction(actor, input, unsuppress) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const found = await client.query<ActionRow>(
          `select action.* from managed_conversation_memory_actions action
           join managed_conversation_executions execution
             on execution.id=action.execution_id
            and execution.owner_user_id=action.owner_user_id
           join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id
            and binding.owner_user_id=execution.owner_user_id
            and binding.execution_generation=action.execution_generation
           join sessions session
             on session.id=binding.local_session_id
            and session.logical_session_id=action.logical_session_id
            and session.owner_user_id=action.owner_user_id
          where action.owner_user_id=$1 and action.id=$2
            and action.execution_id=$3
            and execution.logical_session_id=action.logical_session_id
            and session.personal_deleted_at is null and session.trashed_at is null
          for update of action`,
          [actor.userId, input.actionId, input.executionId]
        );
        const row = found.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        const action = await present(provider, row);
        if (action.result?.outcome === "undone") {
          await client.query("commit");
          return action;
        }
        if (
          row.state !== "completed" ||
          action.result?.outcome !== "forgotten" ||
          !action.result.assertionId ||
          !action.result.suppressionToken
        ) {
          await client.query("rollback");
          return null;
        }
        let restored: unknown;
        try {
          restored = await unsuppress(
            action.result.assertionId,
            action.result.suppressionToken
          );
        } catch (error) {
          // If the unsuppress transaction committed just before a process crash,
          // the action row still says forgotten. Reconcile only an owned,
          // currently unsuppressed assertion; never retry with a new token.
          if ((error as { statusCode?: unknown }).statusCode !== 409)
            throw error;
          const current = await client.query<{ id: string }>(
            `select id from curated_memory_assertions
            where id=$1 and owner_user_id=$2 and visibility='personal'
              and status='current' and suppressed_at is null`,
            [action.result.assertionId, actor.userId]
          );
          if (!current.rows[0]) throw error;
          restored = current.rows[0];
        }
        if (!restored) {
          await client.query("rollback");
          return null;
        }
        const undone: ManagedMemoryActionResult = {
          outcome: "undone",
          message: "Restored this memory.",
          assertionId: action.result.assertionId,
          ...(action.result.citationAlias
            ? { citationAlias: action.result.citationAlias }
            : {})
        };
        const encrypted = await envelopeFor(provider, row, "result", undone);
        const updated = await client.query<ActionRow>(
          `update managed_conversation_memory_actions
            set encrypted_result=$3::jsonb,updated_at=now()
          where id=$1 and owner_user_id=$2 and state='completed' returning *`,
          [action.id, actor.userId, JSON.stringify(encrypted)]
        );
        await client.query("commit");
        return updated.rows[0] ? present(provider, updated.rows[0]) : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async countManagedMemoryActionsForRewrap(input = {}) {
      const column = input.sourceColumn;
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from managed_conversation_memory_actions
        where ($1::uuid is null or owner_user_id=$1)
          and ($2::text is null or ($2='encrypted_request' and encrypted_request is not null)
            or ($2='encrypted_result' and encrypted_result is not null))`,
        [input.ownerUserId ?? null, column ?? null]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async withManagedMemoryActionLease(actor, input, process) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await client.query<
          ActionRow & {
            local_session_id: string;
            client_user_message_id: string | null;
            authority_valid: boolean;
          }
        >(
          `select action.*,session.id as local_session_id,
                command.client_user_message_id,
                (command.state='dispatching' and command.lease_token=$4
                 and command.lease_expires_at>now()
                 and command.execution_id=action.execution_id
                 and command.execution_generation=action.execution_generation
                 and execution.execution_generation=action.execution_generation
                 and execution.runner_lease_expires_at>now()
                 and execution.state in ('running','reconciling')
                 and session.personal_deleted_at is null
                 and session.trashed_at is null) as authority_valid
           from managed_conversation_memory_actions action
           join managed_conversation_commands command
             on command.id=action.command_id
            and command.owner_user_id=action.owner_user_id
           join managed_conversation_executions execution
             on execution.id=action.execution_id
            and execution.owner_user_id=action.owner_user_id
           join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id
            and binding.owner_user_id=execution.owner_user_id
            and binding.execution_generation=action.execution_generation
           join sessions session
             on session.id=binding.local_session_id
            and session.logical_session_id=action.logical_session_id
            and session.owner_user_id=action.owner_user_id
          where action.owner_user_id=$1 and action.id=$2 and action.command_id=$3
          for update of action,command,execution,session`,
          [actor.userId, input.actionId, input.commandId, input.leaseToken]
        );
        const row = locked.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        if (row.state !== "pending") {
          await client.query("commit");
          return present(provider, row);
        }
        if (!row.authority_valid || !row.client_user_message_id) {
          await client.query("rollback");
          return null;
        }
        const action = await present(provider, row);
        const result = await process(action, {
          localSessionId: row.local_session_id,
          clientUserMessageId: row.client_user_message_id
        });
        const encrypted = await envelopeFor(provider, row, "result", result);
        const updated = await client.query<ActionRow>(
          `update managed_conversation_memory_actions
            set state=$3,encrypted_result=$4::jsonb,completed_at=now(),updated_at=now()
          where owner_user_id=$1 and id=$2 and state='pending'
          returning *`,
          [
            actor.userId,
            action.id,
            result.outcome === "forgotten" ||
            result.outcome === "proposal_created"
              ? "completed"
              : "rejected",
            JSON.stringify(encrypted)
          ]
        );
        await client.query("commit");
        return updated.rows[0] ? present(provider, updated.rows[0]) : null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async bindManagedMemoryActionUserSource(actor, input) {
      if (
        input.fromLine < 0 ||
        input.toLine <= input.fromLine ||
        input.toLine - input.fromLine > 5000 ||
        !input.providerPrompt
      )
        return null;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const authority = await client.query<{
          id: string;
          command_kind: string;
          encrypted_payload: Record<string, unknown> | null;
        }>(
          `select command.id,command.command_kind,command.encrypted_payload from managed_conversation_commands command
           join managed_conversation_executions execution
             on execution.id=command.execution_id and execution.owner_user_id=command.owner_user_id
           join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
              and binding.execution_generation=$4 and binding.local_session_id=$6
           join sessions session on session.id=binding.local_session_id
             and session.owner_user_id=command.owner_user_id
             and session.logical_session_id=execution.logical_session_id
           join conversation_source_artifacts artifact
             on artifact.session_id=session.id and artifact.owner_user_id=command.owner_user_id
              and artifact.source_kind=$8 and artifact.external_session_id=$9
              and artifact.source_generation_id=$10 and artifact.provider_cursor_line >= $11
              and artifact.source_component_role='primary' and artifact.lifecycle='active'
           where command.id=$2 and command.owner_user_id=$1 and command.execution_id=$3
             and command.command_kind in ('prompt','hq_catch_up')
             and command.execution_generation=$4 and command.lease_token=$5
             and command.lease_expires_at>now() and command.state='dispatching'
             and command.client_user_message_id=$7
             and execution.execution_generation=$4 and execution.state in ('running','reconciling')
             and execution.runner_lease_expires_at>now()
             and session.personal_deleted_at is null and session.trashed_at is null
           for update of command,execution,session`,
          [
            actor.userId,
            input.commandId,
            input.executionId,
            input.executionGeneration,
            input.leaseToken,
            input.localSessionId,
            input.clientUserMessageId,
            input.sourceKind,
            input.externalSessionId,
            input.sourceGenerationId,
            input.toLine
          ]
        );
        if (authority.rows.length !== 1) {
          await client.query("rollback");
          return null;
        }
        if (authority.rows[0]!.command_kind === "hq_catch_up") {
          const encrypted = authority.rows[0]!.encrypted_payload;
          const envelope = encrypted as
            | (EncryptedPayloadEnvelope & Record<string, unknown>)
            | null;
          if (
            !envelope ||
            envelope.scope?.tenantId !== actor.userId ||
            envelope.scope?.objectClass !== "managed_conversation_prompt" ||
            envelope.provenance?.rowFamily !==
              "managed_conversation_commands" ||
            envelope.provenance?.sourceId !== input.commandId ||
            envelope.ciphertextLocation !==
              "managed_conversation_commands.encrypted_payload" ||
            envelope.aad?.ownerUserId !== actor.userId ||
            envelope.aad?.executionId !== input.executionId ||
            envelope.aad?.commandId !== input.commandId
          ) {
            await client.query("rollback");
            return null;
          }
          const plaintext = encrypted
            ? await decryptEnvelopeToUtf8(provider, envelope)
            : null;
          let payload: unknown;
          try {
            payload = plaintext ? JSON.parse(plaintext) : null;
          } catch {
            payload = null;
          }
          if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload) ||
            (payload as Record<string, unknown>).prompt !== input.providerPrompt
          ) {
            await client.query("rollback");
            return null;
          }
        }
        const items = await client.query<{
          id: string;
          source_line_number: number;
          source_sequence: number;
          canonical_stable_item_id: string;
          raw_text: string | null;
          raw_json: unknown;
          metadata: Record<string, unknown>;
          projection_status: string;
        }>(
          `select id,source_line_number,source_sequence,canonical_stable_item_id,
                  raw_text,raw_json,metadata,projection_status from conversation_items
           where owner_user_id=$1 and session_id=$2 and visibility='personal'
             and source_kind=$3 and external_session_id=$4
             and source_line_number >= $5 and source_line_number < $6
             and source_fingerprint=(select source_fingerprint from conversation_source_artifacts
               where owner_user_id=$1 and session_id=$2 and source_kind=$3
                 and external_session_id=$4 and source_component_role='primary'
                 and source_generation_id=$7 and lifecycle='active' limit 1)
             and source_event_type='user_message'
             and personal_deleted_at is null and memory_excluded_at is null
           order by source_line_number,source_sequence`,
          [
            actor.userId,
            input.localSessionId,
            input.sourceKind,
            input.externalSessionId,
            input.fromLine,
            input.toLine,
            input.sourceGenerationId
          ]
        );
        const groups = new Map<number, typeof items.rows>();
        for (const item of items.rows) {
          const group = groups.get(item.source_line_number) ?? [];
          group.push(item);
          groups.set(item.source_line_number, group);
        }
        const candidates: (typeof items.rows)[] = [];
        for (const group of groups.values()) {
          const plaintext = await Promise.all(
            group.map(async (item) => {
              const columns = Array.isArray(
                item.metadata.encryptedConversationItemColumns
              )
                ? item.metadata.encryptedConversationItemColumns
                : [];
              const decrypt = async (column: "raw_json" | "raw_text") =>
                (
                  await decryptAuthorizedEncryptedFieldPayloadWithClient(
                    client,
                    actor,
                    provider,
                    {
                      sourceTable: "conversation_items",
                      sourceId: item.id,
                      sourceColumn: column
                    }
                  )
                )?.plaintext;
              return {
                text: columns.includes("raw_text")
                  ? await decrypt("raw_text")
                  : item.raw_text,
                json: columns.includes("raw_json")
                  ? await decrypt("raw_json")
                  : item.raw_json
              };
            })
          );
          if (
            plaintext
              .map((value) =>
                typeof value.text === "string" ? value.text : ""
              )
              .join("\n") !== input.providerPrompt
          )
            continue;
          const first = group[0];
          if (
            !first?.canonical_stable_item_id ||
            group.some(
              (item) =>
                !item.canonical_stable_item_id?.startsWith(
                  first.canonical_stable_item_id!.replace(/:[0-9]+$/, ":")
                )
            )
          )
            continue;
          const record = (
            plaintext[0]?.json as {
              sourceRecord?: Record<string, unknown>;
            } | null
          )?.sourceRecord;
          if (
            !record ||
            record.isSidechain === true ||
            typeof record.agentId === "string" ||
            typeof record.parentAgentId === "string"
          )
            continue;
          const content = (record.message as { content?: unknown } | undefined)
            ?.content;
          if (
            Array.isArray(content) &&
            content.some(
              (block) =>
                !!block &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "tool_result"
            )
          )
            continue;
          const isUser =
            input.sourceKind === "pi"
              ? record.type === "message" &&
                (record.message as { role?: string } | undefined)?.role ===
                  "user"
              : record.type === "user";
          if (isUser) candidates.push(group);
        }
        if (candidates.length !== 1 || candidates[0]!.length !== 1) {
          await client.query("rollback");
          return null;
        }
        const item = candidates[0]![0]!;
        const catchUp = authority.rows[0]!.command_kind === "hq_catch_up";
        if (
          catchUp &&
          !(
            item.projection_status === "held" ||
            (item.projection_status === "raw_only" &&
              item.metadata.managedKoedCatchUpCommandId === input.commandId)
          )
        ) {
          await client.query("rollback");
          return null;
        }
        const existing = item.metadata.managedClientUserMessageId;
        if (
          (existing !== undefined && existing !== input.clientUserMessageId) ||
          (catchUp &&
            item.metadata.managedKoedCatchUpCommandId !== undefined &&
            item.metadata.managedKoedCatchUpCommandId !== input.commandId)
        ) {
          await client.query("rollback");
          return null;
        }
        await client.query(
          `update conversation_items set
              metadata=case when $4::boolean then
                jsonb_set(jsonb_set(metadata,'{managedClientUserMessageId}',to_jsonb($3::text),true),
                  '{managedKoedCatchUpCommandId}',to_jsonb($5::text),true)
                else jsonb_set(metadata,'{managedClientUserMessageId}',to_jsonb($3::text),true) end,
              projection_status=case when $4::boolean then 'raw_only' else projection_status end
           where id=$1 and owner_user_id=$2`,
          [
            item.id,
            actor.userId,
            input.clientUserMessageId,
            catchUp,
            input.commandId
          ]
        );
        await client.query("commit");
        return item.id;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async getManagedMemoryActionUserSource(actor, input) {
      const rows = await pool.query<{ id: string }>(
        `select item.id from conversation_items item
         join sessions session
           on session.id=item.session_id
          and session.owner_user_id=item.owner_user_id
         join managed_conversation_commands command
           on command.id=$2 and command.owner_user_id=item.owner_user_id
         join managed_conversation_executions execution
           on execution.id=command.execution_id
          and execution.owner_user_id=command.owner_user_id
        where item.owner_user_id=$1 and item.visibility='personal'
          and item.session_id=$4 and session.personal_deleted_at is null
          and session.trashed_at is null
          and session.logical_session_id=execution.logical_session_id
          and command.command_kind='prompt'
          and command.client_user_message_id=$3
          and ((item.source_kind='codex'
                and item.metadata->>'transcriptType'='user_message'
                and item.canonical_stable_item_id='koed-user-message:' || $3::text)
               or (item.source_kind in ('pi','claude-code')
                   and item.source_event_type='user_message'
                   and item.metadata->>'managedClientUserMessageId'=$3::text))
          and item.personal_deleted_at is null
          and item.memory_excluded_at is null
        limit 2`,
        [
          actor.userId,
          input.commandId,
          input.clientUserMessageId,
          input.localSessionId
        ]
      );
      return rows.rows.length === 1 ? rows.rows[0]!.id : null;
    },

    async findManagedMemoryCorrectionProposal(actor, actionId) {
      const found = await pool.query<{ id: string }>(
        `select id from curated_memory_proposals
        where owner_user_id=$1 and visibility='personal'
          and created_by_model='managed-memory-correct'
          and created_by_prompt_version=$2
        limit 2`,
        [actor.userId, `memory-correct-v1:${actionId}`]
      );
      return found.rows.length === 1 ? found.rows[0]!.id : null;
    },

    async resolveManagedMemorySourceSession(actor, input) {
      const found = await pool.query<{
        session_id: string | null;
        active: boolean;
      }>(
        `with candidates as (
         select m.session_id from messages m
          where $2='message' and m.id=$3::uuid and m.owner_user_id=$1
            and m.visibility='personal' and m.invalidated_at is null
         union all
         select e.session_id from memory_events e
          where $2='memory_event' and e.id=$3::uuid and e.owner_user_id=$1
            and e.visibility='personal' and e.invalidated_at is null
         union all
         select ci.session_id from memory_event_sources es
           join memory_events e on e.id=es.memory_event_id and e.owner_user_id=$1
           join conversation_items ci on ci.id=es.conversation_item_id
          where $2='memory_event' and es.memory_event_id=$3::uuid
            and ci.owner_user_id=$1 and ci.visibility='personal'
            and ci.personal_deleted_at is null
         union all
         select n.session_id from memory_nodes n
          where $2='memory_node' and n.id=$3::uuid and n.owner_user_id=$1
            and n.visibility='personal' and n.invalidated_at is null
         union all
         select m.session_id from memory_node_sources ns
           join memory_nodes n on n.id=ns.memory_node_id and n.owner_user_id=$1
           join messages m on m.id=ns.message_id and m.owner_user_id=$1
          where $2='memory_node' and ns.memory_node_id=$3::uuid
         union all
         select e.session_id from memory_node_sources ns
           join memory_nodes n on n.id=ns.memory_node_id and n.owner_user_id=$1
           join memory_events e on e.id=ns.memory_event_id and e.owner_user_id=$1
          where $2='memory_node' and ns.memory_node_id=$3::uuid
         union all
         select t.session_id from memory_node_sources ns
           join memory_nodes n on n.id=ns.memory_node_id and n.owner_user_id=$1
           join tool_events t on t.id=ns.tool_event_id and t.owner_user_id=$1
          where $2='memory_node' and ns.memory_node_id=$3::uuid
         union all
         select ci.session_id from memory_node_sources ns
           join memory_nodes n on n.id=ns.memory_node_id and n.owner_user_id=$1
           join memory_event_sources es on es.memory_event_id=ns.memory_event_id
           join conversation_items ci on ci.id=es.conversation_item_id
          where $2='memory_node' and ns.memory_node_id=$3::uuid
            and ci.owner_user_id=$1 and ci.visibility='personal'
            and ci.personal_deleted_at is null
       )
       select distinct candidates.session_id,
         (s.id is not null and s.trashed_at is null
          and s.personal_deleted_at is null and s.delete_batch_id is null
          and s.forget_batch_id is null) as active
         from candidates
         left join sessions s on s.id=candidates.session_id and s.owner_user_id=$1
        limit 3`,
        [actor.userId, input.sourceType, input.sourceId]
      );
      return found.rows.length === 1 && found.rows[0]!.active
        ? found.rows[0]!.session_id
        : null;
    },

    async rewrapManagedMemoryActionBatch(nextProvider, input = {}) {
      if (!nextProvider.rewrap)
        throw new Error("Managed memory action provider cannot rewrap");
      const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
      const rows = await pool.query<ActionRow>(
        `select * from managed_conversation_memory_actions
        where ($1::uuid is null or owner_user_id=$1)
          and ($2::uuid is null or id>$2)
          and (
            ($8::text is null or $8='encrypted_request')
              and (encrypted_request->>'providerMode')=$3
              and (encrypted_request->>'keyId')=$4
              and ($5::boolean or (encrypted_request->>'keyVersion')<>$6)
            or ($8::text is null or $8='encrypted_result')
              and encrypted_result is not null
              and (encrypted_result->>'providerMode')=$3
              and (encrypted_result->>'keyId')=$4
              and ($5::boolean or (encrypted_result->>'keyVersion')<>$6)
          )
        order by id limit $7`,
        [
          input.ownerUserId ?? null,
          input.afterId ?? null,
          nextProvider.mode,
          nextProvider.keyId,
          input.force ?? false,
          nextProvider.keyVersion,
          batchSize,
          input.sourceColumn ?? null
        ]
      );
      if (input.dryRun)
        return {
          processedRows: rows.rows.length,
          rewrappedRows: 0,
          done: rows.rows.length < batchSize,
          nextCursorId: rows.rows.at(-1)?.id ?? null
        };
      let rewrappedRows = 0;
      for (const row of rows.rows) {
        for (const field of ["request", "result"] as const) {
          if (input.sourceColumn && input.sourceColumn !== `encrypted_${field}`)
            continue;
          const old =
            field === "request" ? row.encrypted_request : row.encrypted_result;
          if (!old) continue;
          if (
            old.providerMode !== nextProvider.mode ||
            old.keyId !== nextProvider.keyId ||
            (!input.force && old.keyVersion === nextProvider.keyVersion)
          )
            continue;
          verifyEnvelope(row, field, old);
          await decryptEnvelopeToUtf8(nextProvider, old);
          const rewrapped = await nextProvider.rewrap(old);
          const updated = await pool.query(
            `update managed_conversation_memory_actions
              set encrypted_${field}=$2::jsonb
            where id=$1 and owner_user_id=$3 and encrypted_${field}=$4::jsonb`,
            [
              row.id,
              JSON.stringify(rewrapped),
              row.owner_user_id,
              JSON.stringify(old)
            ]
          );
          rewrappedRows += updated.rowCount ?? 0;
        }
      }
      return {
        processedRows: rows.rows.length,
        rewrappedRows,
        done: rows.rows.length < batchSize,
        nextCursorId: rows.rows.at(-1)?.id ?? null
      };
    }
  };
};
