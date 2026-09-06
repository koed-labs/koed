import type pg from "pg";
import { REALTIME_TRANSPORT_TICKET_VERSION } from "@koed/shared";
import type {
  RealtimeTransportId,
  RealtimeTransportOperationFamily
} from "@koed/shared";

export type RealtimeTransportTicketAuthKind = "session" | "device_credential";

export interface CreateRealtimeTransportTicketInput {
  id: string;
  secretHash: string;
  ticketVersion: number;
  transport: RealtimeTransportId;
  protocolVersion: number;
  ownerUserId: string;
  authKind: RealtimeTransportTicketAuthKind;
  userSessionId: string | null;
  deviceCredentialId: string | null;
  backendIdentityHash: string;
  clientInstanceHash: string;
  clientKind: "browser" | "native";
  originHash: string | null;
  nativeBindingHash: string | null;
  operationFamilies: RealtimeTransportOperationFamily[];
  expiresAt: Date;
}

export interface ConsumeRealtimeTransportTicketInput {
  id: string;
  secretHash: string;
  transport: RealtimeTransportId;
  protocolVersion: number;
  backendIdentityHash: string;
  clientInstanceHash: string;
  clientKind: "browser" | "native";
  originHash: string | null;
  nativeBindingHash: string | null;
  connectionIdHash: string;
}

export interface RealtimeTransportAdmissionRecord {
  ticketId: string;
  ownerUserId: string;
  authKind: RealtimeTransportTicketAuthKind;
  userSessionId: string | null;
  deviceCredentialId: string | null;
  transport: RealtimeTransportId;
  protocolVersion: number;
  operationFamilies: RealtimeTransportOperationFamily[];
  consumedAt: string;
}

export interface RealtimeTransportPrincipalState {
  user: { id: string; email: string; displayName: string | null };
  operationFamilies: string[] | null;
}

export interface RealtimeTransportTicketRepository {
  createTicket(input: CreateRealtimeTransportTicketInput): Promise<void>;
  consumeTicket(
    input: ConsumeRealtimeTransportTicketInput
  ): Promise<RealtimeTransportAdmissionRecord | null>;
  resolveActivePrincipal(
    admission: RealtimeTransportAdmissionRecord
  ): Promise<RealtimeTransportPrincipalState | null>;
  revokeTicketsForPrincipal(input: {
    ownerUserId: string;
    userSessionId?: string;
    deviceCredentialId?: string;
  }): Promise<number>;
  deleteExpiredTickets(now?: Date): Promise<number>;
}

export const createRealtimeTransportTicketRepository = (
  pool: pg.Pool
): RealtimeTransportTicketRepository => ({
  async createTicket(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into realtime_transport_tickets (
         id, secret_hash, ticket_version, transport, protocol_version,
         owner_user_id, auth_kind, user_session_id, device_credential_id,
         backend_identity_hash, client_instance_hash, client_kind,
         origin_hash, native_binding_hash, operation_families, expires_at
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       )`,
        [
          input.id,
          input.secretHash,
          input.ticketVersion,
          input.transport,
          input.protocolVersion,
          input.ownerUserId,
          input.authKind,
          input.userSessionId,
          input.deviceCredentialId,
          input.backendIdentityHash,
          input.clientInstanceHash,
          input.clientKind,
          input.originHash,
          input.nativeBindingHash,
          input.operationFamilies,
          input.expiresAt
        ]
      );
      await client.query(
        `insert into audit_events (
           actor_user_id, owner_user_id, visibility, action,
           target_table, target_id, metadata
         ) values ($1,$1,null,'realtime.transport_ticket.issued',
                   'realtime_transport_tickets',$2,$3::jsonb)`,
        [
          input.ownerUserId,
          input.id,
          JSON.stringify({
            authKind: input.authKind,
            transport: input.transport,
            protocolVersion: input.protocolVersion,
            clientKind: input.clientKind,
            operationFamilies: input.operationFamilies,
            expiresAt: input.expiresAt.toISOString()
          })
        ]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async consumeTicket(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{
        id: string;
        owner_user_id: string;
        auth_kind: RealtimeTransportTicketAuthKind;
        user_session_id: string | null;
        device_credential_id: string | null;
        transport: RealtimeTransportId;
        protocol_version: number;
        operation_families: RealtimeTransportOperationFamily[];
        consumed_at: Date;
      }>(
        `update realtime_transport_tickets
          set consumed_at = now(), connection_id_hash = $11
        where id = $1
          and secret_hash = $2
          and transport = $3
          and protocol_version = $4
          and backend_identity_hash = $5
          and client_instance_hash = $6
          and client_kind = $7
          and origin_hash is not distinct from $8
          and native_binding_hash is not distinct from $9
          and ticket_version = $10
          and expires_at > now()
          and consumed_at is null
          and revoked_at is null
          and (
            (auth_kind = 'session' and exists (
              select 1
                from user_sessions s
                join users u on u.id = s.user_id
               where s.id = realtime_transport_tickets.user_session_id
                 and s.user_id = realtime_transport_tickets.owner_user_id
                 and s.revoked_at is null
                 and s.expires_at > now()
                 and u.disabled_at is null
                 and u.deleted_at is null
            ))
            or (auth_kind = 'device_credential' and exists (
              select 1
                from device_credentials d
                join users u on u.id = d.owner_user_id
               where d.id = realtime_transport_tickets.device_credential_id
                 and d.owner_user_id = realtime_transport_tickets.owner_user_id
                 and d.revoked_at is null
                 and (d.expires_at is null or d.expires_at > now())
                 and realtime_transport_tickets.operation_families <@ d.operation_families
                 and u.disabled_at is null
                 and u.deleted_at is null
            ))
          )
        returning id, owner_user_id, auth_kind, user_session_id,
                  device_credential_id, transport, protocol_version,
                  operation_families, consumed_at`,
        [
          input.id,
          input.secretHash,
          input.transport,
          input.protocolVersion,
          input.backendIdentityHash,
          input.clientInstanceHash,
          input.clientKind,
          input.originHash,
          input.nativeBindingHash,
          REALTIME_TRANSPORT_TICKET_VERSION,
          input.connectionIdHash
        ]
      );
      const row = result.rows[0];
      if (row) {
        await client.query(
          `insert into audit_events (
             actor_user_id, owner_user_id, visibility, action,
             target_table, target_id, metadata
           ) values ($1,$1,null,'realtime.transport_ticket.consumed',
                     'realtime_transport_tickets',$2,$3::jsonb)`,
          [
            row.owner_user_id,
            row.id,
            JSON.stringify({
              authKind: row.auth_kind,
              transport: row.transport,
              protocolVersion: row.protocol_version,
              operationFamilies: row.operation_families
            })
          ]
        );
      }
      await client.query("commit");
      return row
        ? {
            ticketId: row.id,
            ownerUserId: row.owner_user_id,
            authKind: row.auth_kind,
            userSessionId: row.user_session_id,
            deviceCredentialId: row.device_credential_id,
            transport: row.transport,
            protocolVersion: row.protocol_version,
            operationFamilies: row.operation_families,
            consumedAt: row.consumed_at.toISOString()
          }
        : null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async resolveActivePrincipal(admission) {
    if (admission.authKind === "session") {
      if (!admission.userSessionId || admission.deviceCredentialId) return null;
      const result = await pool.query<{
        id: string;
        email: string;
        display_name: string | null;
      }>(
        `select u.id, u.email, u.display_name
           from user_sessions s
           join users u on u.id = s.user_id
          where s.id = $1
            and s.user_id = $2
            and s.revoked_at is null
            and s.expires_at > now()
            and u.disabled_at is null
            and u.deleted_at is null`,
        [admission.userSessionId, admission.ownerUserId]
      );
      const row = result.rows[0];
      return row
        ? {
            user: {
              id: row.id,
              email: row.email,
              displayName: row.display_name
            },
            operationFamilies: null
          }
        : null;
    }
    if (!admission.deviceCredentialId || admission.userSessionId) return null;
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      operation_families: string[];
    }>(
      `select u.id, u.email, u.display_name, d.operation_families
         from device_credentials d
         join users u on u.id = d.owner_user_id
        where d.id = $1
          and d.owner_user_id = $2
          and d.revoked_at is null
          and (d.expires_at is null or d.expires_at > now())
          and $3::text[] <@ d.operation_families
          and u.disabled_at is null
          and u.deleted_at is null`,
      [
        admission.deviceCredentialId,
        admission.ownerUserId,
        admission.operationFamilies
      ]
    );
    const row = result.rows[0];
    return row
      ? {
          user: {
            id: row.id,
            email: row.email,
            displayName: row.display_name
          },
          operationFamilies: row.operation_families
        }
      : null;
  },

  async revokeTicketsForPrincipal(input) {
    if (!input.userSessionId && !input.deviceCredentialId) return 0;
    const result = await pool.query(
      `update realtime_transport_tickets
          set revoked_at = now()
        where owner_user_id = $1
          and consumed_at is null
          and revoked_at is null
          and ($2::uuid is null or user_session_id = $2)
          and ($3::uuid is null or device_credential_id = $3)`,
      [
        input.ownerUserId,
        input.userSessionId ?? null,
        input.deviceCredentialId ?? null
      ]
    );
    return result.rowCount ?? 0;
  },

  async deleteExpiredTickets(now = new Date()) {
    const result = await pool.query(
      `delete from realtime_transport_tickets where expires_at <= $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }
});
