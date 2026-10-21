import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import {
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type { ActorContext } from "./types.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const alias = (receiptId: string, ordinal: number): string =>
  `r${receiptId.replaceAll("-", "").toLowerCase()}c${ordinal + 1}`;
export const managedCitationBranchToolCallId = (
  providerToolCallId: string,
  branch: "personal" | "team"
): string =>
  `combined:${createHash("sha256").update(providerToolCallId).digest("hex")}:${branch}`;

export interface ManagedConversationTurnCitation {
  alias: string;
  providerTurnId: string;
  sourceType: "curated_memory" | "memory_node" | "memory_event" | "message";
  sourceId: string;
  visibility: "personal" | "team";
  detailAvailable: boolean;
  title: string;
  summary: string | null;
}

export interface ManagedConversationCitationRepository {
  rewrapManagedConversationCitationBatch(
    provider: EnvelopeEncryptionProvider,
    input?: {
      ownerUserId?: string;
      batchSize?: number;
      afterId?: string;
      dryRun?: boolean;
      force?: boolean;
    }
  ): Promise<{
    processedRows: number;
    rewrappedRows: number;
    done: boolean;
    nextCursorId: string | null;
  }>;
  getManagedConversationCitationLocator(
    actor: ActorContext,
    input: {
      executionId: string;
      providerTurnId: string;
      alias: string;
    }
  ): Promise<{
    backendId: string;
    questionId: string;
    ordinal: number;
    sourceId: string;
    sourceType: ManagedConversationTurnCitation["sourceType"];
    visibility: "personal" | "team";
    sourceNamespace: string;
    sourceOwnerPrincipalId: string;
  } | null>;
  recordManagedConversationToolCitations(
    actor: ActorContext,
    input: ManagedCitationReceiptInput | ManagedCitationReceiptInput[]
  ): Promise<ManagedConversationTurnCitation[]>;
  listManagedConversationTurnCitations(
    actor: ActorContext,
    input: {
      executionId: string;
      providerTurnId: string;
    }
  ): Promise<ManagedConversationTurnCitation[]>;
  listManagedConversationCitationsByAliases(
    actor: ActorContext,
    input: {
      executionId: string;
      aliases: string[];
    }
  ): Promise<ManagedConversationTurnCitation[]>;
}

export interface ManagedCitationReceiptInput {
  executionId: string;
  executionGeneration: number;
  commandId: string;
  leaseToken: string;
  providerTurnId: string;
  toolCallId: string;
  questionId: string;
  receiptId: string;
  observedCitations: unknown[];
  questionBackendId?: string;
  verifiedTeamSources?: Array<{
    sourceType: string;
    sourceId: string;
    teamWorkspaceId: string;
    sourceOwnerPrincipalId: string;
  }>;
  verifiedPersonalSources?: Array<{
    sourceType: string;
    sourceId: string;
    sourceDeploymentId: string;
    sourceOwnerPrincipalId: string;
    title: string;
    summary: string | null;
  }>;
  combined?: {
    providerToolCallId: string;
    branch: "personal" | "team";
    teamBackendId: string;
    teamWorkspaceId: string;
    personalProjectId: string;
    workspaceProjectId: string;
    projectVersion: number;
  };
}

interface CitationRow {
  id: string;
  owner_user_id: string;
  execution_id: string;
  logical_session_id: string;
  execution_generation: number;
  source_generation_id: string | null;
  alias: string;
  provider_turn_id: string;
  tool_call_id: string;
  question_backend_id: string;
  question_id: string;
  ordinal: number;
  source_type: ManagedConversationTurnCitation["sourceType"];
  source_id: string;
  visibility: ManagedConversationTurnCitation["visibility"];
  source_owner_namespace: string;
  source_owner_principal: string;
  encrypted_detail: Record<string, unknown>;
}

const routingIdentity = (row: CitationRow) => ({
  logicalSessionId: row.logical_session_id,
  executionGeneration: row.execution_generation,
  providerTurnId: row.provider_turn_id,
  toolCallId: row.tool_call_id,
  questionBackendId: row.question_backend_id,
  questionId: row.question_id,
  ordinal: row.ordinal,
  alias: row.alias,
  sourceType: row.source_type,
  sourceId: row.source_id,
  visibility: row.visibility,
  sourceOwnerNamespace: row.source_owner_namespace,
  sourceOwnerPrincipal: row.source_owner_principal
});

const liveChatPredicate = `
  exists (select 1 from sessions s
           where s.owner_user_id=c.owner_user_id and s.logical_session_id=c.logical_session_id
             and s.trashed_at is null and s.personal_deleted_at is null
             and s.delete_batch_id is null and s.forget_batch_id is null)
  and not exists (select 1 from sessions blocked
           where blocked.owner_user_id=c.owner_user_id and blocked.logical_session_id=c.logical_session_id
             and (blocked.trashed_at is not null or blocked.personal_deleted_at is not null
               or blocked.delete_batch_id is not null or blocked.forget_batch_id is not null))`;

export const createManagedConversationCitationRepository = (
  pool: pg.Pool,
  options: { envelopeEncryptionProvider?: EnvelopeEncryptionProvider }
): ManagedConversationCitationRepository => {
  const encryption = () => {
    if (!options.envelopeEncryptionProvider)
      throw new Error("Managed citation encryption unavailable");
    return options.envelopeEncryptionProvider;
  };
  const present = async (
    row: CitationRow
  ): Promise<ManagedConversationTurnCitation> => {
    const envelope =
      row.encrypted_detail as unknown as EncryptedPayloadEnvelope;
    if (
      envelope.scope?.tenantId !== row.owner_user_id ||
      envelope.scope?.objectClass !== "managed_conversation_turn_citation" ||
      envelope.provenance?.rowFamily !==
        "managed_conversation_turn_citations" ||
      envelope.provenance?.sourceId !== row.id ||
      envelope.ciphertextLocation !==
        "managed_conversation_turn_citations.encrypted_detail" ||
      envelope.aad?.ownerUserId !== row.owner_user_id ||
      envelope.aad?.executionId !== row.execution_id ||
      envelope.aad?.citationId !== row.id ||
      envelope.aad?.routingIdentityJson !== JSON.stringify(routingIdentity(row))
    )
      throw new Error("Managed citation encrypted custody mismatch");
    const plaintext = await decryptEnvelopeToUtf8(encryption(), envelope);
    const detail = record(JSON.parse(plaintext));
    // Team detail is never served from a retained citation snapshot. It must be
    // fetched from the currently authorized Team backend on every open.
    if (row.visibility === "team")
      return {
        alias: row.alias,
        providerTurnId: row.provider_turn_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        visibility: "team",
        detailAvailable: false,
        title: "Team memory unavailable",
        summary: null
      };
    return {
      alias: row.alias,
      providerTurnId: row.provider_turn_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      visibility: row.visibility,
      detailAvailable: true,
      title: string(detail.title) ?? "Memory",
      summary: string(detail.summary)
    };
  };
  const select = async (
    actor: ActorContext,
    input: { executionId: string; providerTurnId: string }
  ) => {
    const result = await pool.query<CitationRow>(
      `select c.*
         from managed_conversation_turn_citations c
         join managed_conversation_executions e on e.id=c.execution_id and e.owner_user_id=c.owner_user_id
        where c.owner_user_id=$1 and c.execution_id=$2 and c.provider_turn_id=$3
          and ${liveChatPredicate}
        order by c.created_at,c.tool_call_id,c.ordinal`,
      [actor.userId, input.executionId, input.providerTurnId]
    );
    return Promise.all(result.rows.map(present));
  };
  return {
    async rewrapManagedConversationCitationBatch(provider, input = {}) {
      if (!provider.rewrap)
        throw new Error("Managed citation provider cannot rewrap");
      const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 500);
      const rows = await pool.query<CitationRow>(
        `select c.* from managed_conversation_turn_citations c
          where (c.encrypted_detail->>'providerMode')=$1
            and (c.encrypted_detail->>'keyId')=$2
            and ($3::uuid is null or c.owner_user_id=$3)
            and ($4::uuid is null or c.id>$4)
            and ($5::boolean or (c.encrypted_detail->>'keyVersion')<>$6)
          order by c.id limit $7`,
        [
          provider.mode,
          provider.keyId,
          input.ownerUserId ?? null,
          input.afterId ?? null,
          input.force ?? false,
          provider.keyVersion,
          batchSize
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
        const envelope =
          row.encrypted_detail as unknown as EncryptedPayloadEnvelope;
        if (
          envelope.aad?.ownerUserId !== row.owner_user_id ||
          envelope.aad?.executionId !== row.execution_id ||
          envelope.aad?.citationId !== row.id ||
          envelope.aad?.routingIdentityJson !==
            JSON.stringify(routingIdentity(row))
        )
          throw new Error("Managed citation encrypted custody mismatch");
        await decryptEnvelopeToUtf8(provider, envelope);
        const rewrapped = await provider.rewrap(envelope);
        const updated = await pool.query(
          `update managed_conversation_turn_citations set encrypted_detail=$2::jsonb
             where id=$1 and owner_user_id=$3 and encrypted_detail=$4::jsonb`,
          [
            row.id,
            JSON.stringify(rewrapped),
            row.owner_user_id,
            JSON.stringify(envelope)
          ]
        );
        rewrappedRows += updated.rowCount ?? 0;
      }
      return {
        processedRows: rows.rows.length,
        rewrappedRows,
        done: rows.rows.length < batchSize,
        nextCursorId: rows.rows.at(-1)?.id ?? null
      };
    },
    async recordManagedConversationToolCitations(actor, input) {
      const receipts = Array.isArray(input) ? input : [input];
      if (!receipts.length || receipts.length > 2)
        throw new Error("Managed citation receipt batch is invalid");
      const first = receipts[0]!;
      if (
        receipts.some(
          (receipt) =>
            receipt.executionId !== first.executionId ||
            receipt.executionGeneration !== first.executionGeneration ||
            receipt.commandId !== first.commandId ||
            receipt.leaseToken !== first.leaseToken ||
            receipt.providerTurnId !== first.providerTurnId
        ) ||
        new Set(receipts.map((receipt) => receipt.toolCallId)).size !==
          receipts.length
      )
        throw new Error(
          "Managed citation branch receipts do not share one provider call"
        );
      if (
        receipts.length > 1 &&
        (receipts[0]?.combined?.branch !== "personal" ||
          receipts[1]?.combined?.branch !== "team")
      )
        throw new Error("Managed citation branch order is invalid");
      if (
        receipts.some((receipt) => {
          const combined = receipt.combined;
          if (!combined) return receipts.length > 1;
          return (
            combined.providerToolCallId.length < 1 ||
            combined.providerToolCallId.length > 512 ||
            receipt.toolCallId !==
              managedCitationBranchToolCallId(
                combined.providerToolCallId,
                combined.branch
              ) ||
            combined.teamBackendId !== first.combined?.teamBackendId ||
            combined.teamWorkspaceId !== first.combined?.teamWorkspaceId ||
            combined.personalProjectId !== first.combined?.personalProjectId ||
            combined.workspaceProjectId !==
              first.combined?.workspaceProjectId ||
            combined.projectVersion !== first.combined?.projectVersion ||
            combined.providerToolCallId !==
              first.combined?.providerToolCallId ||
            (combined.branch === "personal" &&
              (!!receipt.questionBackendId ||
                !receipt.verifiedPersonalSources)) ||
            (combined.branch === "team" &&
              (receipt.questionBackendId !== combined.teamBackendId ||
                !receipt.verifiedTeamSources ||
                receipt.verifiedTeamSources.some(
                  (source) =>
                    source.teamWorkspaceId !== combined.teamWorkspaceId
                )))
          );
        })
      )
        throw new Error("Managed citation branch call binding is invalid");
      const prepared = receipts.map((input) => {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.receiptId
          )
        )
          throw new Error("Managed citation receipt is invalid");
        const remoteTeam = Boolean(
          input.questionBackendId && input.verifiedTeamSources
        );
        const attestedPersonal = Boolean(input.verifiedPersonalSources);
        if (remoteTeam === attestedPersonal)
          throw new Error(
            "Managed citation requires one verified source authority"
          );
        if (
          Boolean(input.questionBackendId) !==
          Boolean(input.verifiedTeamSources)
        )
          throw new Error("Managed citation Team provenance is incomplete");
        const questionVisibility = remoteTeam ? "team" : "personal";
        const canonicalCitations = input.observedCitations.map((source) => {
          const { citationId: _alias, ...canonical } = record(source);
          void _alias;
          return canonical;
        });
        // The runner verified each observed citation against the source backend's
        // durable question before this lease-bound attestation is accepted.
        if (
          canonicalCitations.length !== input.observedCitations.length ||
          (remoteTeam &&
            input.verifiedTeamSources!.length !== canonicalCitations.length) ||
          (attestedPersonal &&
            input.verifiedPersonalSources!.length !== canonicalCitations.length)
        )
          throw new Error(
            "Managed citation tool result does not match the question"
          );
        for (const [ordinal, source] of canonicalCitations.entries()) {
          const observed = record(input.observedCitations[ordinal]);
          const canonical = record(source);
          const { citationId: _citationId, ...withoutAlias } = observed;
          void _citationId;
          if (
            observed.citationId !== alias(input.receiptId, ordinal) ||
            JSON.stringify(withoutAlias) !== JSON.stringify(canonical)
          )
            throw new Error(
              "Managed citation tool result does not match the question"
            );
        }
        return {
          input,
          canonicalCitations,
          remoteTeam,
          attestedPersonal,
          questionVisibility
        };
      });
      const client = await pool.connect();
      try {
        await client.query("begin");
        const execution = await client.query<{
          logical_session_id: string | null;
          source_generation_id: string | null;
        }>(
          `select logical_session_id,source_generation_id
             from managed_conversation_executions
            where id=$1 and owner_user_id=$2 and execution_generation=$3
              and state in ('running','reconciling','quiesce_requested','quiesced')
            for share`,
          [first.executionId, actor.userId, first.executionGeneration]
        );
        const bound = execution.rows[0];
        if (!bound?.logical_session_id)
          throw new Error("Managed citation execution binding is unavailable");
        if (first.combined) {
          const link = await client.query(
            `select p.id from managed_conversation_executions e
               join projects p on p.id::text=e.project_id and p.owner_user_id=e.owner_user_id
               join sessions s on s.owner_user_id=e.owner_user_id
                 and s.logical_session_id=e.logical_session_id
                 and (case when s.project_override_id is not null then s.project_override_personal_project_id else s.automatic_personal_project_id end)=p.id
              where e.id=$1 and e.owner_user_id=$2 and e.execution_generation=$3
                and p.id=$4 and p.version=$5 and p.team_backend_id=$6
                and p.team_workspace_id=$7 and p.workspace_project_id=$8
                and p.lifecycle='active' and p.deletion_phase is null
                and s.visibility='personal' and s.invalidated_at is null
                and s.trashed_at is null and s.personal_deleted_at is null
                and s.delete_batch_id is null and s.forget_batch_id is null
              limit 1 for share of p,s,e`,
            [
              first.executionId,
              actor.userId,
              first.executionGeneration,
              first.combined.personalProjectId,
              first.combined.projectVersion,
              first.combined.teamBackendId,
              first.combined.teamWorkspaceId,
              first.combined.workspaceProjectId
            ]
          );
          if (link.rowCount !== 1)
            throw new Error("Managed citation Project link changed");
        }
        // Lock the command through the insert transaction. A runner HTTP precheck
        // alone cannot prevent an expired, replaced, or retired lease from
        // recording aliases while the source backend is being consulted.
        const command = await client.query(
          `select id from managed_conversation_commands
            where id=$1 and owner_user_id=$2 and execution_id=$3
              and execution_generation=$4 and lease_token=$5
              and state='dispatching' and lease_expires_at>clock_timestamp()
            for share`,
          [
            first.commandId,
            actor.userId,
            first.executionId,
            first.executionGeneration,
            first.leaseToken
          ]
        );
        if (command.rowCount !== 1)
          throw new Error("Managed citation command lease is unavailable");
        for (const {
          input,
          canonicalCitations,
          remoteTeam,
          attestedPersonal,
          questionVisibility
        } of prepared) {
          for (const [ordinal, source] of canonicalCitations.entries()) {
            const citation = record(source);
            const representation = string(citation.representation);
            const sourceType =
              string(citation.sourceType) ??
              (representation === "curated_assertions"
                ? "curated_memory"
                : representation === "memory_events"
                  ? "memory_event"
                  : representation?.startsWith("lcm_")
                    ? "memory_node"
                    : citation.nodeId
                      ? "memory_node"
                      : null);
            const sourceId =
              string(citation.sourceId) ?? string(citation.nodeId);
            if (
              !sourceId ||
              ![
                "curated_memory",
                "memory_node",
                "memory_event",
                "message"
              ].includes(sourceType ?? "")
            )
              continue;
            let sourceNamespace = "";
            let sourcePrincipal = "";
            let backendId = "";
            if (attestedPersonal) {
              const attested = input.verifiedPersonalSources![ordinal]!;
              if (
                attested.sourceId !== sourceId ||
                attested.sourceType !== sourceType ||
                !attested.sourceDeploymentId ||
                !attested.sourceOwnerPrincipalId
              )
                throw new Error(
                  "Managed citation Personal provenance mismatch"
                );
              backendId = `personal:${attested.sourceDeploymentId}`;
              sourceNamespace = attested.sourceDeploymentId;
              sourcePrincipal = attested.sourceOwnerPrincipalId;
            } else if (remoteTeam) {
              const attested = input.verifiedTeamSources![ordinal]!;
              if (
                attested.sourceId !== sourceId ||
                attested.sourceType !== sourceType ||
                !attested.teamWorkspaceId ||
                !attested.sourceOwnerPrincipalId ||
                !input.questionBackendId
              )
                throw new Error("Managed citation Team provenance mismatch");
              backendId = `team:${input.questionBackendId}`;
              sourceNamespace = `${input.questionBackendId}:${attested.teamWorkspaceId}`;
              sourcePrincipal = attested.sourceOwnerPrincipalId;
            }
            if (!sourceNamespace || !sourcePrincipal || !backendId)
              throw new Error(
                "Managed citation source authority is unavailable"
              );
            const citationAlias = alias(input.receiptId, ordinal);
            const rowId = randomUUID();
            const route = routingIdentity({
              logical_session_id: bound.logical_session_id,
              execution_generation: input.executionGeneration,
              provider_turn_id: input.providerTurnId,
              tool_call_id: input.toolCallId,
              question_backend_id: backendId,
              question_id: input.questionId,
              ordinal,
              alias: citationAlias,
              source_type:
                sourceType as ManagedConversationTurnCitation["sourceType"],
              source_id: sourceId,
              visibility: questionVisibility,
              source_owner_namespace: sourceNamespace,
              source_owner_principal: sourcePrincipal
            } as CitationRow);
            const encrypted = await encryption().encrypt({
              plaintext: JSON.stringify({
                ...(questionVisibility === "personal"
                  ? {
                      title: input.verifiedPersonalSources![ordinal]!.title,
                      summary: input.verifiedPersonalSources![ordinal]!.summary
                    }
                  : {}),
                ...(questionVisibility === "personal"
                  ? { citation }
                  : {
                      questionId: input.questionId,
                      ordinal,
                      backendId,
                      sourceNamespace,
                      sourcePrincipal,
                      sourceId
                    }),
                ...(input.combined ? { combined: input.combined } : {})
              }),
              scope: {
                tenantId: actor.userId,
                objectClass: "managed_conversation_turn_citation"
              },
              provenance: {
                rowFamily: "managed_conversation_turn_citations",
                sourceId: rowId
              },
              ciphertextLocation:
                "managed_conversation_turn_citations.encrypted_detail",
              aad: {
                ownerUserId: actor.userId,
                executionId: input.executionId,
                citationId: rowId,
                routingIdentityJson: JSON.stringify(route)
              }
            });
            const inserted = await client.query(
              `insert into managed_conversation_turn_citations
              (id,owner_user_id,logical_session_id,execution_id,execution_generation,source_generation_id,
               provider_turn_id,tool_call_id,question_backend_id,question_id,ordinal,alias,source_type,source_id,
               visibility,source_owner_namespace,source_owner_principal,encrypted_detail)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
             on conflict do nothing returning id`,
              [
                rowId,
                actor.userId,
                bound.logical_session_id,
                input.executionId,
                input.executionGeneration,
                null,
                input.providerTurnId,
                input.toolCallId,
                backendId,
                input.questionId,
                ordinal,
                citationAlias,
                sourceType,
                sourceId,
                questionVisibility,
                sourceNamespace,
                sourcePrincipal,
                JSON.stringify(encrypted)
              ]
            );
            if (!inserted.rowCount) {
              const existing = await client.query<{
                question_id: string;
                ordinal: number;
                alias: string;
                tool_call_id: string;
                source_type: string;
                source_id: string;
                visibility: string;
                question_backend_id: string;
                source_owner_namespace: string;
                source_owner_principal: string;
                encrypted_detail: Record<string, unknown>;
              }>(
                `select question_id,ordinal,alias,tool_call_id,source_type,source_id,visibility,question_backend_id,
                      source_owner_namespace,source_owner_principal,encrypted_detail
                 from managed_conversation_turn_citations
                where owner_user_id=$1 and execution_id=$2 and execution_generation=$3 and provider_turn_id=$4
                  and (alias=$5 or (tool_call_id=$6 and ordinal=$7)) for share`,
                [
                  actor.userId,
                  input.executionId,
                  input.executionGeneration,
                  input.providerTurnId,
                  citationAlias,
                  input.toolCallId,
                  ordinal
                ]
              );
              if (
                existing.rows.length !== 1 ||
                existing.rows[0]!.question_id !== input.questionId ||
                existing.rows[0]!.ordinal !== ordinal ||
                existing.rows[0]!.alias !== citationAlias ||
                existing.rows[0]!.tool_call_id !== input.toolCallId ||
                existing.rows[0]!.source_type !== sourceType ||
                existing.rows[0]!.source_id !== sourceId ||
                existing.rows[0]!.visibility !== questionVisibility ||
                existing.rows[0]!.question_backend_id !== backendId ||
                existing.rows[0]!.source_owner_namespace !== sourceNamespace ||
                existing.rows[0]!.source_owner_principal !== sourcePrincipal
              )
                throw new Error(
                  "Managed citation tool completion conflicts with an immutable alias"
                );
              if (input.combined) {
                const retained = record(
                  JSON.parse(
                    await decryptEnvelopeToUtf8(
                      encryption(),
                      existing.rows[0]!
                        .encrypted_detail as unknown as EncryptedPayloadEnvelope
                    )
                  )
                );
                if (
                  JSON.stringify(retained.combined) !==
                  JSON.stringify(input.combined)
                )
                  throw new Error(
                    "Managed citation branch binding conflicts with an immutable alias"
                  );
              }
            }
          }
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return select(actor, first);
    },
    listManagedConversationTurnCitations: select,
    async listManagedConversationCitationsByAliases(actor, input) {
      if (
        input.aliases.length > 64 ||
        input.aliases.some(
          (value) => !/^r[0-9a-f]{32}c[1-9][0-9]*$/.test(value)
        )
      )
        throw new Error("Managed citation alias lookup is invalid");
      if (!input.aliases.length) return [];
      const result = await pool.query<CitationRow>(
        `select c.* from managed_conversation_turn_citations c
          join managed_conversation_executions e on e.id=c.execution_id and e.owner_user_id=c.owner_user_id
         where c.owner_user_id=$1 and c.execution_id=$2 and c.alias=any($3::text[])
           and ${liveChatPredicate}
         order by c.created_at,c.tool_call_id,c.ordinal`,
        [actor.userId, input.executionId, [...new Set(input.aliases)]]
      );
      return Promise.all(result.rows.map(present));
    },
    async getManagedConversationCitationLocator(actor, input) {
      const result = await pool.query<
        CitationRow & {
          question_backend_id: string;
          question_id: string;
          ordinal: number;
          source_owner_namespace: string;
          source_owner_principal: string;
        }
      >(
        `select c.*
           from managed_conversation_turn_citations c
           join managed_conversation_executions e on e.id=c.execution_id and e.owner_user_id=c.owner_user_id
          where c.owner_user_id=$1 and c.execution_id=$2 and c.provider_turn_id=$3 and c.alias=$4
            and ${liveChatPredicate} limit 1`,
        [actor.userId, input.executionId, input.providerTurnId, input.alias]
      );
      const row = result.rows[0];
      if (!row || !row.question_backend_id.startsWith(`${row.visibility}:`))
        return null;
      await present(row);
      const backendId = row.question_backend_id.slice(
        row.visibility.length + 1
      );
      if (
        row.visibility === "team" &&
        !row.source_owner_namespace.startsWith(`${backendId}:`)
      )
        return null;
      if (
        row.visibility === "personal" &&
        row.source_owner_namespace !== backendId
      )
        return null;
      return {
        backendId,
        questionId: row.question_id,
        ordinal: row.ordinal,
        sourceId: row.source_id,
        sourceType: row.source_type,
        visibility: row.visibility,
        sourceNamespace: row.source_owner_namespace,
        sourceOwnerPrincipalId: row.source_owner_principal
      };
    }
  };
};
