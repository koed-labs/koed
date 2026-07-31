import { createHash, randomUUID } from "node:crypto";
import {
  highRiskActionGrantCommitment,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider
} from "@koed/shared";
import type pg from "pg";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { auditEventValues } from "./audit-repository.js";
import { createDb, type KoedDb } from "./connection.js";
import { createRetentionLifecycleRepository } from "./retention-lifecycle-repository.js";
import { createSharedMemoryRepository } from "./shared-memory-repository.js";
import { createCrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import { createExternalAuthRepository } from "./external-auth-repository.js";
import { createConversationSourceJournalRepository } from "./conversation-source-journal-repository.js";
import { createDeviceCredentialRepository } from "./device-credential-repository.js";
import { createManagedConversationForkRepository } from "./managed-conversation-fork-repository.js";
import { createManagedConversationRepository } from "./managed-conversation-repository.js";
import { createManagedConversationTransferRepository } from "./managed-conversation-transfer-repository.js";
import { createPersonalDeviceSyncRepository } from "./personal-device-sync-repository.js";
import {
  auditEvents,
  deviceCredentials,
  highRiskActionGrantExecutionReceipts,
  highRiskBrowserConfirmations,
  highRiskDeviceActionGrants,
  legalHolds,
  userSessions
} from "./schema.js";
import { createTeamAccessRepository } from "./team-access-repository.js";

export const defaultHighRiskConfirmationTtlMs = 5 * 60 * 1000;
export const defaultHighRiskActionGrantTtlMs = 60 * 1000;
export const defaultFreshAuthenticationMaxAgeMs = 5 * 60 * 1000;
export const maximumHighRiskConfirmationTtlMs = 10 * 60 * 1000;
export const maximumHighRiskActionGrantTtlMs = 5 * 60 * 1000;
export const maximumFreshAuthenticationMaxAgeMs = 15 * 60 * 1000;

type PersistedHighRiskConfirmationState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked";

export type HighRiskConfirmationState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked";

export type HighRiskActionGrantState = HighRiskConfirmationState;

export interface HighRiskOperationBinding {
  ownerUserId: string;
  deviceCredentialId: string;
  upstreamBackendId: string;
  teamId: string | null;
  operationFamily: string;
  action: string;
  targetId: string | null;
  scopeHash: string;
  requestHash: string;
}

export interface HighRiskActionGrantBindingRecord extends HighRiskOperationBinding {
  id: string;
  selector: string;
  state: HighRiskActionGrantState;
  createdAt: string;
  expiresAt: string;
}

export interface CreateHighRiskActionGrantInput extends HighRiskOperationBinding {
  clientRequestId: string;
  grantCommitment: string;
  credentialOperationFamily:
    | "action_grant"
    | "share_grant_management"
    | "sync"
    | "managed_execution";
}

export interface GetHighRiskActionGrantInput {
  clientRequestId: string;
  ownerUserId: string;
  deviceCredentialId: string;
  upstreamBackendId: string;
}

export interface AwaitHighRiskActionGrantInput extends GetHighRiskActionGrantInput {
  maxWaitMs?: number;
  signal?: AbortSignal;
}

export interface CancelHighRiskActionGrantInput extends GetHighRiskActionGrantInput {
  reasonCode: string;
}

export interface GetHighRiskBrowserActivationInput {
  selector: string;
  ownerUserId: string;
}

export interface DecideHighRiskBrowserActivationInput {
  selector: string;
  ownerUserId: string;
  userSessionId: string;
  freshlyAuthenticatedAt: Date;
  decision: "approve" | "deny";
}

export interface HighRiskMutationReceipt<TBody> {
  statusCode: number;
  body: TBody;
}

export interface ExecuteHighRiskActionGrantInput<
  TBody
> extends HighRiskOperationBinding {
  actionGrant: string;
  execute: (repositories: {
    team: ReturnType<typeof createTeamAccessRepository>;
    retention: ReturnType<typeof createRetentionLifecycleRepository>;
    sharedMemory: ReturnType<typeof createSharedMemoryRepository>;
    sync: ReturnType<typeof createCrossIdentitySyncRepository>;
    sourceJournal: ReturnType<typeof createConversationSourceJournalRepository>;
    managedConversation: ReturnType<
      typeof createManagedConversationRepository
    > &
      ReturnType<typeof createManagedConversationForkRepository> &
      ReturnType<typeof createManagedConversationTransferRepository> &
      ReturnType<typeof createDeviceCredentialRepository> &
      ReturnType<typeof createPersonalDeviceSyncRepository>;
    externalAuth: ReturnType<typeof createExternalAuthRepository>;
  }) => Promise<HighRiskMutationReceipt<TBody> | null>;
}

export interface ExecutedHighRiskActionGrant<
  TBody
> extends HighRiskMutationReceipt<TBody> {
  replayed: boolean;
}

export interface HighRiskActionRepositoryOptions {
  confirmationTtlMs?: number;
  actionGrantTtlMs?: number;
  freshAuthenticationMaxAgeMs?: number;
  pool?: pg.Pool;
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider;
}

export interface HighRiskActionRepository {
  createActionGrant(
    input: CreateHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  getActionGrant(
    input: GetHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  awaitActionGrant(
    input: AwaitHighRiskActionGrantInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  cancelActionGrant(input: CancelHighRiskActionGrantInput): Promise<boolean>;
  getBrowserActivation(
    input: GetHighRiskBrowserActivationInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  decideBrowserActivation(
    input: DecideHighRiskBrowserActivationInput
  ): Promise<HighRiskActionGrantBindingRecord | null>;
  executeActionGrant<TBody>(
    input: ExecuteHighRiskActionGrantInput<TBody>
  ): Promise<ExecutedHighRiskActionGrant<TBody> | null>;
  lookupLegalHoldTeamId(holdId: string): Promise<string | null>;
  expireBrowserConfirmations(): Promise<number>;
  expireActionGrants(): Promise<number>;
}

type BrowserConfirmationRow = typeof highRiskBrowserConfirmations.$inferSelect;
type ActionGrantRow = typeof highRiskDeviceActionGrants.$inferSelect;
type ActionGrantExecutionReceiptRow =
  typeof highRiskActionGrantExecutionReceipts.$inferSelect;

const timestampIso = (value: Date): string => value.toISOString();

const highRiskActionGrantNotificationChannel = "koed_high_risk_action_grants";

const notifyActionGrant = (
  client: Pick<pg.PoolClient, "query">,
  clientRequestId: string
) =>
  client.query(
    `select pg_notify('${highRiskActionGrantNotificationChannel}', $1)`,
    [clientRequestId]
  );

const notifyActionGrantWithDb = (db: KoedDb, clientRequestId: string) =>
  db.execute(
    sql`select pg_notify(${highRiskActionGrantNotificationChannel}, ${clientRequestId})`
  );

const validateTtl = (name: string, value: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`
    );
  }
  return value;
};

const validateHash = (name: string, value: string): void => {
  if (value.length !== 64) {
    throw new Error(`${name} must be a 64-character hash`);
  }
};

const validateReasonCode = (reasonCode: string): void => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(reasonCode)) {
    throw new Error("High-risk action revocation reason code is invalid");
  }
};

const validateUuid = (name: string, value: string): void => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error(`${name} must be a UUID`);
  }
};

const validateGrantCommitment = (value: string): void => {
  if (!/^v1:[0-9A-Fa-f]{64}$/.test(value)) {
    throw new Error("High-risk action grant commitment is invalid");
  }
};

const validateOperationBinding = (input: HighRiskOperationBinding): void => {
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.operationFamily)) {
    throw new Error("High-risk operation family is invalid");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(input.action)) {
    throw new Error("High-risk action is invalid");
  }
  if (input.upstreamBackendId.length === 0) {
    throw new Error("High-risk action upstream backend is required");
  }
  validateHash("High-risk action scope hash", input.scopeHash);
  validateHash("High-risk action request hash", input.requestHash);
};

const validateCredentialOperationFamily = (
  input: CreateHighRiskActionGrantInput
): void => {
  const expected =
    input.operationFamily === "admin"
      ? "action_grant"
      : input.operationFamily === "share_grant_management"
        ? "share_grant_management"
        : input.operationFamily === "source_download"
          ? "sync"
          : input.operationFamily === "managed_execution"
            ? "managed_execution"
            : null;
  if (input.credentialOperationFamily !== expected) {
    throw new Error(
      "High-risk credential operation family does not match the protected operation"
    );
  }
};

const operationAuditMetadata = (
  input: Pick<
    HighRiskOperationBinding,
    | "deviceCredentialId"
    | "upstreamBackendId"
    | "teamId"
    | "operationFamily"
    | "action"
    | "targetId"
  >,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  deviceCredentialId: input.deviceCredentialId,
  upstreamBackendId: input.upstreamBackendId,
  ...(input.teamId ? { teamId: input.teamId } : {}),
  operationFamily: input.operationFamily,
  operationAction: input.action,
  operationTargetId: input.targetId,
  ...extra
});

const confirmationAuditMetadata = (
  row: BrowserConfirmationRow,
  extra: Record<string, unknown> = {}
) =>
  operationAuditMetadata(
    {
      deviceCredentialId: row.deviceCredentialId,
      upstreamBackendId: row.upstreamBackendId,
      teamId: row.teamId,
      operationFamily: row.operationFamily,
      action: row.action,
      targetId: row.targetId
    },
    extra
  );

const grantAuditMetadata = (
  row: ActionGrantRow,
  extra: Record<string, unknown> = {}
) =>
  operationAuditMetadata(row, {
    confirmationId: row.confirmationId,
    ...extra
  });

const insertAudit = async (
  tx: KoedDb,
  input: {
    ownerUserId: string;
    teamId: string | null;
    action: string;
    targetTable: string;
    targetId: string;
    metadata: Record<string, unknown>;
    actorUserId?: string | null;
  }
): Promise<void> => {
  await tx.insert(auditEvents).values(
    auditEventValues({
      actorUserId: input.actorUserId ?? null,
      ownerUserId: input.ownerUserId,
      visibility: input.teamId ? null : "personal",
      action: input.action,
      targetTable: input.targetTable,
      targetId: input.targetId,
      metadata: input.metadata
    })
  );
};

const apiStateFromRows = (
  confirmation: Pick<BrowserConfirmationRow, "state" | "revocationReasonCode">,
  grant: Pick<
    ActionGrantRow,
    "state" | "revocationReasonCode" | "consumedAt"
  > | null
): HighRiskActionGrantState => {
  if (grant?.state === "expired" || confirmation.state === "expired") {
    return "expired";
  }
  if (confirmation.state === "denied") {
    return "denied";
  }
  if (grant?.state === "revoked" || confirmation.state === "revoked") {
    return "revoked";
  }
  if (confirmation.state === "pending") {
    return "pending";
  }
  return "approved";
};

const mapBindingRecord = (
  confirmation: BrowserConfirmationRow,
  grant: ActionGrantRow | null
): HighRiskActionGrantBindingRecord => ({
  id: confirmation.clientRequestId,
  selector: confirmation.selector,
  state: apiStateFromRows(confirmation, grant),
  ownerUserId: confirmation.ownerUserId,
  deviceCredentialId: confirmation.deviceCredentialId,
  upstreamBackendId: confirmation.upstreamBackendId,
  teamId: confirmation.teamId,
  operationFamily: confirmation.operationFamily,
  action: confirmation.action,
  targetId: confirmation.targetId,
  scopeHash: confirmation.scopeHash,
  requestHash: confirmation.requestHash,
  createdAt: timestampIso(confirmation.createdAt),
  expiresAt: timestampIso(grant?.expiresAt ?? confirmation.expiresAt)
});

const queryText = (
  input: string | { text: string } | undefined
): string | null => {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "text" in input) {
    return typeof input.text === "string" ? input.text : null;
  }
  return null;
};

const createSavepointPool = (client: pg.PoolClient): pg.Pool => {
  let depth = 0;
  const emptyQueryResult = (): pg.QueryResult<pg.QueryResultRow> => ({
    command: "OK",
    rowCount: null,
    oid: 0,
    fields: [],
    rows: []
  });
  const savepointClient = {
    async query(
      ...args: Parameters<pg.PoolClient["query"]>
    ): Promise<pg.QueryResult<pg.QueryResultRow>> {
      const [input, params] = args;
      const text = queryText(input)?.trim().toLowerCase();
      if (text === "begin") {
        depth += 1;
        await client.query(`savepoint koed_high_risk_${depth}`);
        return emptyQueryResult();
      }
      if (text === "commit") {
        if (depth > 0) {
          await client.query(`release savepoint koed_high_risk_${depth}`);
          depth -= 1;
        }
        return emptyQueryResult();
      }
      if (text === "rollback") {
        if (depth > 0) {
          await client.query(`rollback to savepoint koed_high_risk_${depth}`);
          depth -= 1;
        }
        return emptyQueryResult();
      }
      return params === undefined
        ? client.query(input as string)
        : client.query(input as string, params as never);
    },
    release() {}
  };

  return {
    connect() {
      return Promise.resolve(savepointClient as pg.PoolClient);
    },
    query(
      ...args: Parameters<pg.Pool["query"]>
    ): Promise<pg.QueryResult<pg.QueryResultRow>> {
      return savepointClient.query(
        ...(args as Parameters<pg.PoolClient["query"]>)
      );
    }
  } as unknown as pg.Pool;
};

const buildScopedRepositories = (
  client: pg.PoolClient,
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider,
  ownerPrivateReplicaEnvelopeEncryptionProvider?: EnvelopeEncryptionProvider
) => {
  const savepointPool = createSavepointPool(client);
  return {
    team: createTeamAccessRepository(savepointPool, {
      envelopeEncryptionProvider
    }),
    retention: createRetentionLifecycleRepository(savepointPool, {
      authorizeHoldActor: async (context) => {
        if (context.target.scope === "owner_private_replica") {
          return context.authority === "personal_memory.legal_hold.manage";
        }
        const result = await client.query(
          `select 1
             from team_memberships tm
             join teams t on t.id = tm.team_id
            where tm.team_id = $1
              and tm.user_id = $2
              and tm.role in ('owner', 'admin')
              and tm.status = 'enabled'
              and tm.disabled_at is null
              and t.lifecycle in ('active', 'deletion_requested', 'purge_pending')
            limit 1`,
          [context.target.teamId, context.actorUserId]
        );
        return result.rowCount === 1;
      }
    }),
    sharedMemory: createSharedMemoryRepository(savepointPool, {
      resolveTeamEncryptionProvider: () => {
        if (!envelopeEncryptionProvider) {
          throw new Error(
            "Envelope encryption is required for Shared Memory execution"
          );
        }
        return Promise.resolve(envelopeEncryptionProvider);
      },
      resolveOwnerPrivateReplicaEncryptionProvider: () => {
        if (!ownerPrivateReplicaEnvelopeEncryptionProvider) {
          throw new Error(
            "Owner-private replica envelope encryption is required for Shared Memory execution"
          );
        }
        return Promise.resolve(ownerPrivateReplicaEnvelopeEncryptionProvider);
      },
      delegatedDeviceActionGrantExecution: true
    }),
    sync: createCrossIdentitySyncRepository(savepointPool, {
      envelopeEncryptionProvider: ownerPrivateReplicaEnvelopeEncryptionProvider
    }),
    sourceJournal: createConversationSourceJournalRepository(savepointPool),
    managedConversation: {
      ...createManagedConversationRepository(savepointPool, {
        envelopeEncryptionProvider
      }),
      ...createManagedConversationForkRepository(savepointPool),
      ...createManagedConversationTransferRepository(savepointPool, {
        envelopeEncryptionProvider
      }),
      ...createDeviceCredentialRepository(createDb(client)),
      ...createPersonalDeviceSyncRepository(savepointPool)
    },
    externalAuth: createExternalAuthRepository(createDb(client))
  };
};

const hashReceiptPayload = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const receiptBodyJson = (body: unknown): string => {
  const value = JSON.stringify(body);
  if (value === undefined) {
    throw new Error("High-risk receipt body must be JSON-serializable");
  }
  return value;
};

interface EncryptedHighRiskReceiptBody {
  version: 1;
  encoding: "envelope";
  envelope: EncryptedPayloadEnvelope;
}

const encryptedReceiptBody = (
  value: unknown
): EncryptedHighRiskReceiptBody | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<EncryptedHighRiskReceiptBody>;
  if (
    candidate.version !== 1 ||
    candidate.encoding !== "envelope" ||
    !candidate.envelope ||
    typeof candidate.envelope !== "object"
  ) {
    return null;
  }
  return candidate as EncryptedHighRiskReceiptBody;
};

const encodeReceiptBody = async (input: {
  provider: EnvelopeEncryptionProvider;
  bodyJson: string;
  grant: ActionGrantRow;
}): Promise<EncryptedHighRiskReceiptBody> => ({
  version: 1,
  encoding: "envelope",
  envelope: await input.provider.encrypt({
    plaintext: input.bodyJson,
    scope: {
      teamId: input.grant.teamId,
      objectClass: "high_risk_action_grant_receipt"
    },
    provenance: {
      rowFamily: "high_risk_action_grant_receipt",
      sourceTable: "high_risk_device_action_grants",
      sourceColumn: "id",
      sourceId: input.grant.id
    },
    ciphertextLocation:
      "high_risk_action_grant_execution_receipts.receipt_body",
    aad: {
      actionGrantId: input.grant.id,
      ownerUserId: input.grant.ownerUserId,
      action: input.grant.action,
      requestHash: input.grant.requestHash
    }
  })
});

const decodeReceiptRow = async <TBody>(
  provider: EnvelopeEncryptionProvider,
  row: Pick<
    ActionGrantExecutionReceiptRow,
    "statusCode" | "receiptBody" | "receiptHash"
  > | null
): Promise<HighRiskMutationReceipt<TBody> | null> => {
  if (!row) return null;
  const stored = encryptedReceiptBody(row.receiptBody);
  if (!stored) {
    throw new Error("High-risk action grant receipt is not encrypted");
  }
  const bodyJson = Buffer.from(
    await provider.decrypt(stored.envelope)
  ).toString("utf8");
  if (hashReceiptPayload(bodyJson) !== row.receiptHash) {
    throw new Error("High-risk action grant receipt integrity check failed");
  }
  return {
    statusCode: row.statusCode,
    body: JSON.parse(bodyJson) as TBody
  };
};

export const createHighRiskActionRepository = (
  db: KoedDb,
  options: HighRiskActionRepositoryOptions
): HighRiskActionRepository => {
  const confirmationTtlMs = validateTtl(
    "High-risk confirmation TTL",
    options.confirmationTtlMs ?? defaultHighRiskConfirmationTtlMs,
    maximumHighRiskConfirmationTtlMs
  );
  const actionGrantTtlMs = validateTtl(
    "High-risk action grant TTL",
    options.actionGrantTtlMs ?? defaultHighRiskActionGrantTtlMs,
    maximumHighRiskActionGrantTtlMs
  );
  const freshAuthenticationMaxAgeMs = validateTtl(
    "Fresh authentication maximum age",
    options.freshAuthenticationMaxAgeMs ?? defaultFreshAuthenticationMaxAgeMs,
    maximumFreshAuthenticationMaxAgeMs
  );

  const ensureFreshTimestamp = (
    freshlyAuthenticatedAt: Date,
    createdAt: Date
  ): void => {
    if (freshlyAuthenticatedAt.getTime() > createdAt.getTime()) {
      throw new Error("Fresh authentication timestamp cannot be in the future");
    }
    if (
      createdAt.getTime() - freshlyAuthenticatedAt.getTime() >
      freshAuthenticationMaxAgeMs
    ) {
      throw new Error("Fresh authentication timestamp is too old");
    }
  };

  const selectConfirmationWithGrant = async (
    tx: KoedDb,
    input: GetHighRiskActionGrantInput
  ): Promise<{
    confirmation: BrowserConfirmationRow;
    grant: ActionGrantRow | null;
  } | null> => {
    const [row] = await tx
      .select({
        confirmation: highRiskBrowserConfirmations,
        grant: highRiskDeviceActionGrants
      })
      .from(highRiskBrowserConfirmations)
      .leftJoin(
        highRiskDeviceActionGrants,
        eq(
          highRiskDeviceActionGrants.confirmationId,
          highRiskBrowserConfirmations.id
        )
      )
      .where(
        and(
          eq(
            highRiskBrowserConfirmations.clientRequestId,
            input.clientRequestId
          ),
          eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
          eq(
            highRiskBrowserConfirmations.deviceCredentialId,
            input.deviceCredentialId
          ),
          eq(
            highRiskBrowserConfirmations.upstreamBackendId,
            input.upstreamBackendId
          )
        )
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return { confirmation: row.confirmation, grant: row.grant };
  };

  const matchesConfirmationBinding = (
    confirmation: BrowserConfirmationRow,
    input: CreateHighRiskActionGrantInput
  ): boolean =>
    confirmation.teamId === input.teamId &&
    confirmation.operationFamily === input.operationFamily &&
    confirmation.action === input.action &&
    confirmation.targetId === input.targetId &&
    confirmation.scopeHash === input.scopeHash &&
    confirmation.requestHash === input.requestHash &&
    confirmation.secretCommitment === input.grantCommitment;

  return {
    async createActionGrant(input) {
      validateUuid("High-risk action grant request ID", input.clientRequestId);
      validateGrantCommitment(input.grantCommitment);
      validateOperationBinding(input);
      validateCredentialOperationFamily(input);
      const createdAt = new Date();

      return db.transaction(async (tx) => {
        const existing = await selectConfirmationWithGrant(tx, {
          clientRequestId: input.clientRequestId,
          ownerUserId: input.ownerUserId,
          deviceCredentialId: input.deviceCredentialId,
          upstreamBackendId: input.upstreamBackendId
        });
        if (existing) {
          if (matchesConfirmationBinding(existing.confirmation, input)) {
            return mapBindingRecord(existing.confirmation, existing.grant);
          }
          return null;
        }

        const [device] = await tx
          .select({ id: deviceCredentials.id })
          .from(deviceCredentials)
          .where(
            and(
              eq(deviceCredentials.id, input.deviceCredentialId),
              eq(deviceCredentials.ownerUserId, input.ownerUserId),
              eq(deviceCredentials.upstreamBackendId, input.upstreamBackendId),
              sql`${input.credentialOperationFamily} = any(${deviceCredentials.operationFamilies})`,
              isNull(deviceCredentials.revokedAt),
              or(
                isNull(deviceCredentials.expiresAt),
                gt(deviceCredentials.expiresAt, sql`now()`)
              )
            )
          )
          .limit(1);
        if (!device) {
          return null;
        }

        const [confirmation] = await tx
          .insert(highRiskBrowserConfirmations)
          .values({
            selector: randomUUID(),
            clientRequestId: input.clientRequestId,
            ownerUserId: input.ownerUserId,
            deviceCredentialId: input.deviceCredentialId,
            upstreamBackendId: input.upstreamBackendId,
            teamId: input.teamId,
            operationFamily: input.operationFamily,
            action: input.action,
            targetId: input.targetId,
            scopeHash: input.scopeHash,
            requestHash: input.requestHash,
            secretCommitment: input.grantCommitment,
            createdAt,
            expiresAt: new Date(createdAt.getTime() + confirmationTtlMs)
          })
          // The idempotency key and secret commitment are independently
          // unique. Resolve either race through the scoped binding lookup.
          .onConflictDoNothing()
          .returning();
        if (!confirmation) {
          const concurrent = await selectConfirmationWithGrant(tx, {
            clientRequestId: input.clientRequestId,
            ownerUserId: input.ownerUserId,
            deviceCredentialId: input.deviceCredentialId,
            upstreamBackendId: input.upstreamBackendId
          });
          return concurrent &&
            matchesConfirmationBinding(concurrent.confirmation, input)
            ? mapBindingRecord(concurrent.confirmation, concurrent.grant)
            : null;
        }

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: input.ownerUserId,
          teamId: input.teamId,
          action: "high_risk.browser_confirmation.created",
          targetTable: "high_risk_browser_confirmations",
          targetId: confirmation!.id,
          metadata: confirmationAuditMetadata(confirmation!)
        });

        return mapBindingRecord(confirmation!, null);
      });
    },

    async getActionGrant(input) {
      const row = await selectConfirmationWithGrant(db, input);
      return row ? mapBindingRecord(row.confirmation, row.grant) : null;
    },

    async awaitActionGrant(input) {
      const pool = options.pool;
      if (!pool) {
        throw new Error(
          "A database pool is required for Action Grant notifications"
        );
      }
      const client = await pool.connect();
      let notified = false;
      let wake: (() => void) | null = null;
      const onNotification = (message: {
        channel: string;
        payload?: string;
      }) => {
        if (
          message.channel === highRiskActionGrantNotificationChannel &&
          message.payload === input.clientRequestId
        ) {
          notified = true;
          wake?.();
        }
      };
      client.on("notification", onNotification);
      try {
        await client.query(`listen ${highRiskActionGrantNotificationChannel}`);
        const read = async () => {
          const row = await selectConfirmationWithGrant(
            createDb(client),
            input
          );
          return row ? mapBindingRecord(row.confirmation, row.grant) : null;
        };
        const current = await read();
        if (!current || current.state !== "pending") {
          return current;
        }
        const remainingMs = Date.parse(current.expiresAt) - Date.now();
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
          return { ...current, state: "expired" };
        }
        if (!notified) {
          const maxWaitMs = input.maxWaitMs ?? remainingMs;
          const waitMs = Math.min(
            remainingMs,
            Number.isFinite(maxWaitMs) ? Math.max(0, maxWaitMs) : remainingMs
          );
          let onAbort: (() => void) | null = null;
          try {
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(resolve, waitMs);
              onAbort = () => {
                clearTimeout(timeout);
                reject(
                  Object.assign(new Error("Action Grant wait was aborted"), {
                    name: "AbortError"
                  })
                );
              };
              wake = () => {
                clearTimeout(timeout);
                resolve();
              };
              if (input.signal?.aborted) {
                onAbort();
                return;
              }
              input.signal?.addEventListener("abort", onAbort, { once: true });
            });
          } finally {
            if (onAbort) {
              input.signal?.removeEventListener("abort", onAbort);
            }
          }
        }
        const resolved = await read();
        return resolved?.state === "pending" &&
          Date.parse(resolved.expiresAt) <= Date.now()
          ? { ...resolved, state: "expired" }
          : resolved;
      } finally {
        wake = null;
        client.removeListener("notification", onNotification);
        await client
          .query(`unlisten ${highRiskActionGrantNotificationChannel}`)
          .catch(() => undefined);
        client.release();
      }
    },

    async cancelActionGrant(input) {
      validateReasonCode(input.reasonCode);
      return db.transaction(async (tx) => {
        const confirmationRow = await selectConfirmationWithGrant(tx, input);
        if (!confirmationRow) {
          return false;
        }

        const allowedConfirmationStates: PersistedHighRiskConfirmationState[] =
          ["pending", "approved"];
        if (
          !allowedConfirmationStates.includes(
            confirmationRow.confirmation.state
          )
        ) {
          return false;
        }
        if (confirmationRow.grant && confirmationRow.grant.state !== "active") {
          return false;
        }

        const [confirmation] = await tx
          .update(highRiskBrowserConfirmations)
          .set({
            state: "revoked",
            revokedAt: sql`now()`,
            revocationReasonCode: input.reasonCode
          })
          .where(
            and(
              eq(
                highRiskBrowserConfirmations.clientRequestId,
                input.clientRequestId
              ),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
              inArray(highRiskBrowserConfirmations.state, [
                "pending",
                "approved"
              ]),
              isNull(highRiskBrowserConfirmations.revokedAt)
            )
          )
          .returning();
        if (!confirmation) {
          return false;
        }

        if (confirmationRow.grant && confirmationRow.grant.state === "active") {
          await tx
            .update(highRiskDeviceActionGrants)
            .set({
              state: "revoked",
              revokedAt: sql`now()`,
              revocationReasonCode: input.reasonCode
            })
            .where(eq(highRiskDeviceActionGrants.id, confirmationRow.grant.id));
        }

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: confirmation.ownerUserId,
          teamId: confirmation.teamId,
          action: "high_risk.browser_confirmation.revoked",
          targetTable: "high_risk_browser_confirmations",
          targetId: confirmation.id,
          metadata: confirmationAuditMetadata(confirmation, {
            reasonCode: input.reasonCode
          })
        });
        await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
        return true;
      });
    },

    async getBrowserActivation(input) {
      const row = await db
        .select({
          confirmation: highRiskBrowserConfirmations,
          grant: highRiskDeviceActionGrants
        })
        .from(highRiskBrowserConfirmations)
        .leftJoin(
          highRiskDeviceActionGrants,
          eq(
            highRiskDeviceActionGrants.confirmationId,
            highRiskBrowserConfirmations.id
          )
        )
        .where(
          and(
            eq(highRiskBrowserConfirmations.selector, input.selector),
            eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId)
          )
        )
        .limit(1);
      return row[0]
        ? mapBindingRecord(row[0].confirmation, row[0].grant)
        : null;
    },

    async decideBrowserActivation(input) {
      const createdAt = new Date();
      ensureFreshTimestamp(input.freshlyAuthenticatedAt, createdAt);

      return db.transaction(async (tx) => {
        const [session] = await tx
          .select({ id: userSessions.id })
          .from(userSessions)
          .where(
            and(
              eq(userSessions.id, input.userSessionId),
              eq(userSessions.userId, input.ownerUserId),
              isNull(userSessions.revokedAt),
              gt(userSessions.expiresAt, sql`now()`)
            )
          )
          .limit(1);
        if (!session) {
          return null;
        }

        const existing = await tx
          .select({
            confirmation: highRiskBrowserConfirmations,
            grant: highRiskDeviceActionGrants
          })
          .from(highRiskBrowserConfirmations)
          .leftJoin(
            highRiskDeviceActionGrants,
            eq(
              highRiskDeviceActionGrants.confirmationId,
              highRiskBrowserConfirmations.id
            )
          )
          .where(
            and(
              eq(highRiskBrowserConfirmations.selector, input.selector),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId)
            )
          )
          .limit(1);
        const current = existing[0];
        if (
          !current ||
          current.confirmation.state !== "pending" ||
          current.grant !== null ||
          current.confirmation.expiresAt.getTime() <= Date.now()
        ) {
          return null;
        }

        if (input.decision === "deny") {
          const [confirmation] = await tx
            .update(highRiskBrowserConfirmations)
            .set({
              decisionUserSessionId: input.userSessionId,
              decisionFreshlyAuthenticatedAt: input.freshlyAuthenticatedAt,
              decidedAt: sql`now()`,
              state: "denied"
            })
            .where(
              and(
                eq(highRiskBrowserConfirmations.selector, input.selector),
                eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
                eq(highRiskBrowserConfirmations.state, "pending"),
                isNull(highRiskBrowserConfirmations.decidedAt),
                gt(highRiskBrowserConfirmations.expiresAt, sql`now()`)
              )
            )
            .returning();
          if (!confirmation) {
            return null;
          }
          await insertAudit(tx, {
            actorUserId: input.ownerUserId,
            ownerUserId: confirmation.ownerUserId,
            teamId: confirmation.teamId,
            action: "high_risk.browser_confirmation.denied",
            targetTable: "high_risk_browser_confirmations",
            targetId: confirmation.id,
            metadata: confirmationAuditMetadata(confirmation)
          });
          await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
          return mapBindingRecord(confirmation, null);
        }

        const [confirmation] = await tx
          .update(highRiskBrowserConfirmations)
          .set({
            decisionUserSessionId: input.userSessionId,
            decisionFreshlyAuthenticatedAt: input.freshlyAuthenticatedAt,
            decidedAt: sql`now()`,
            state: "approved"
          })
          .where(
            and(
              eq(highRiskBrowserConfirmations.selector, input.selector),
              eq(highRiskBrowserConfirmations.ownerUserId, input.ownerUserId),
              eq(highRiskBrowserConfirmations.state, "pending"),
              isNull(highRiskBrowserConfirmations.decidedAt),
              gt(highRiskBrowserConfirmations.expiresAt, sql`now()`)
            )
          )
          .returning();
        if (!confirmation) {
          return null;
        }

        const [grant] = await tx
          .insert(highRiskDeviceActionGrants)
          .values({
            confirmationId: confirmation.id,
            deviceCredentialId: confirmation.deviceCredentialId,
            ownerUserId: confirmation.ownerUserId,
            upstreamBackendId: confirmation.upstreamBackendId,
            teamId: confirmation.teamId,
            operationFamily: confirmation.operationFamily,
            action: confirmation.action,
            targetId: confirmation.targetId,
            scopeHash: confirmation.scopeHash,
            requestHash: confirmation.requestHash,
            secretCommitment: confirmation.secretCommitment,
            expiresAt: sql`least(
              ${confirmation.expiresAt},
              now() + (${actionGrantTtlMs}::bigint * interval '1 millisecond')
            )`
          })
          .returning();

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: confirmation.ownerUserId,
          teamId: confirmation.teamId,
          action: "high_risk.browser_confirmation.approved",
          targetTable: "high_risk_browser_confirmations",
          targetId: confirmation.id,
          metadata: confirmationAuditMetadata(confirmation, {
            actionGrantId: grant!.id
          })
        });
        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: grant!.ownerUserId,
          teamId: grant!.teamId,
          action: "high_risk.action_grant.issued",
          targetTable: "high_risk_device_action_grants",
          targetId: grant!.id,
          metadata: grantAuditMetadata(grant!)
        });
        await notifyActionGrantWithDb(tx, confirmation.clientRequestId);

        return mapBindingRecord(confirmation, grant!);
      });
    },

    async executeActionGrant<TBody>(
      input: ExecuteHighRiskActionGrantInput<TBody>
    ) {
      validateOperationBinding(input);
      const receiptEncryptionProvider = options.envelopeEncryptionProvider;
      if (!receiptEncryptionProvider) {
        throw new Error(
          "Envelope encryption is required for high-risk action grant receipts"
        );
      }
      const commitment = highRiskActionGrantCommitment(input.actionGrant);
      const pool = options.pool;
      if (!pool) {
        throw new Error(
          "A database pool is required for atomic high-risk action grant execution"
        );
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        if (input.operationFamily === "share_grant_management") {
          await client.query("set transaction isolation level repeatable read");
        }
        const tx = createDb(client);
        const [row] = await tx
          .select({
            confirmation: highRiskBrowserConfirmations,
            grant: highRiskDeviceActionGrants
          })
          .from(highRiskDeviceActionGrants)
          .innerJoin(
            highRiskBrowserConfirmations,
            eq(
              highRiskBrowserConfirmations.id,
              highRiskDeviceActionGrants.confirmationId
            )
          )
          .where(
            and(
              eq(highRiskDeviceActionGrants.secretCommitment, commitment),
              eq(highRiskDeviceActionGrants.ownerUserId, input.ownerUserId),
              eq(
                highRiskDeviceActionGrants.deviceCredentialId,
                input.deviceCredentialId
              ),
              eq(
                highRiskDeviceActionGrants.upstreamBackendId,
                input.upstreamBackendId
              ),
              input.teamId === null
                ? isNull(highRiskDeviceActionGrants.teamId)
                : eq(highRiskDeviceActionGrants.teamId, input.teamId),
              eq(
                highRiskDeviceActionGrants.operationFamily,
                input.operationFamily
              ),
              eq(highRiskDeviceActionGrants.action, input.action),
              input.targetId === null
                ? isNull(highRiskDeviceActionGrants.targetId)
                : eq(highRiskDeviceActionGrants.targetId, input.targetId),
              eq(highRiskDeviceActionGrants.scopeHash, input.scopeHash),
              eq(highRiskDeviceActionGrants.requestHash, input.requestHash)
            )
          )
          .limit(1)
          .for("update", {
            of: [highRiskDeviceActionGrants, highRiskBrowserConfirmations]
          });
        if (!row) {
          await client.query("rollback");
          return null;
        }

        const grant = row.grant;
        const confirmation = row.confirmation;
        if (
          grant.state === "consumed" &&
          grant.useCount === 1 &&
          grant.consumedAt !== null
        ) {
          const [storedReceipt = null] = await tx
            .select()
            .from(highRiskActionGrantExecutionReceipts)
            .where(
              eq(highRiskActionGrantExecutionReceipts.actionGrantId, grant.id)
            )
            .limit(1);
          const receipt = await decodeReceiptRow<TBody>(
            receiptEncryptionProvider,
            storedReceipt
          );
          await client.query("commit");
          if (!receipt) {
            throw new Error(
              "Consumed high-risk action grant is missing a receipt"
            );
          }
          return { ...receipt, replayed: true };
        }

        if (
          grant.state !== "active" ||
          grant.useCount !== 0 ||
          grant.expiresAt.getTime() <= Date.now() ||
          confirmation.state !== "approved"
        ) {
          await client.query("rollback");
          return null;
        }

        const receipt = await input.execute(
          buildScopedRepositories(
            client,
            options.envelopeEncryptionProvider,
            options.ownerPrivateReplicaEnvelopeEncryptionProvider
          )
        );
        if (!receipt) {
          await client.query("rollback");
          return null;
        }

        const bodyJson = receiptBodyJson(receipt.body);
        const storedBody = await encodeReceiptBody({
          provider: receiptEncryptionProvider,
          bodyJson,
          grant
        });
        await tx
          .insert(highRiskActionGrantExecutionReceipts)
          .values({
            actionGrantId: grant.id,
            ownerUserId: grant.ownerUserId,
            statusCode: receipt.statusCode,
            receiptBody: storedBody,
            receiptHash: hashReceiptPayload(bodyJson)
          })
          .returning({ id: highRiskActionGrantExecutionReceipts.id });
        await tx
          .update(highRiskDeviceActionGrants)
          .set({
            state: "consumed",
            useCount: 1,
            consumedAt: sql`now()`
          })
          .where(eq(highRiskDeviceActionGrants.id, grant.id));

        await insertAudit(tx, {
          actorUserId: input.ownerUserId,
          ownerUserId: grant.ownerUserId,
          teamId: grant.teamId,
          action: "high_risk.action_grant.consumed",
          targetTable: "high_risk_device_action_grants",
          targetId: grant.id,
          metadata: grantAuditMetadata(grant)
        });
        await notifyActionGrant(client, confirmation.clientRequestId);

        await client.query("commit");
        return { ...receipt, replayed: false };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async lookupLegalHoldTeamId(holdId) {
      const [row] = await db
        .select({ teamId: legalHolds.teamId })
        .from(legalHolds)
        .where(eq(legalHolds.id, holdId))
        .limit(1);
      return row?.teamId ?? null;
    },

    async expireBrowserConfirmations() {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(highRiskBrowserConfirmations)
          .set({ state: "expired" })
          .where(
            and(
              eq(highRiskBrowserConfirmations.state, "pending"),
              isNull(highRiskBrowserConfirmations.revokedAt),
              sql`${highRiskBrowserConfirmations.expiresAt} <= now()`
            )
          )
          .returning();

        for (const confirmation of rows) {
          await insertAudit(tx, {
            ownerUserId: confirmation.ownerUserId,
            teamId: confirmation.teamId,
            action: "high_risk.browser_confirmation.expired",
            targetTable: "high_risk_browser_confirmations",
            targetId: confirmation.id,
            metadata: confirmationAuditMetadata(confirmation)
          });
          await notifyActionGrantWithDb(tx, confirmation.clientRequestId);
        }
        return rows.length;
      });
    },

    async expireActionGrants() {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(highRiskDeviceActionGrants)
          .set({ state: "expired" })
          .where(
            and(
              eq(highRiskDeviceActionGrants.state, "active"),
              eq(highRiskDeviceActionGrants.useCount, 0),
              isNull(highRiskDeviceActionGrants.consumedAt),
              isNull(highRiskDeviceActionGrants.revokedAt),
              sql`${highRiskDeviceActionGrants.expiresAt} <= now()`
            )
          )
          .returning();

        for (const grant of rows) {
          await insertAudit(tx, {
            ownerUserId: grant.ownerUserId,
            teamId: grant.teamId,
            action: "high_risk.action_grant.expired",
            targetTable: "high_risk_device_action_grants",
            targetId: grant.id,
            metadata: grantAuditMetadata(grant)
          });
        }
        return rows.length;
      });
    }
  };
};
