import type pg from "pg";

export interface RemoteMcpOAuthRequest {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  state?: string;
}

export interface RemoteMcpOAuthGrant {
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
}

export interface RemoteMcpOAuthCredential {
  hash: string;
  kind: "code" | "access" | "refresh";
  expiresAt: Date;
  data: { scopes: string[]; codeChallenge?: string; redirectUri?: string };
}

export interface RemoteMcpOAuthStore {
  getClient(id: string): Promise<Record<string, unknown> | undefined>;
  registerClient(id: string, metadata: Record<string, unknown>): Promise<void>;
  createRequest(
    hash: string,
    request: RemoteMcpOAuthRequest,
    expiresAt: Date
  ): Promise<void>;
  getRequest(
    hash: string,
    now: Date
  ): Promise<{ request: RemoteMcpOAuthRequest; expiresAt: Date } | null>;
  completeRequest(input: {
    hash: string;
    userId: string;
    approved: boolean;
    grantId: string;
    grantExpiresAt: Date;
    code: RemoteMcpOAuthCredential;
    now: Date;
  }): Promise<RemoteMcpOAuthRequest | null>;
  getCode(
    hash: string,
    clientId: string,
    now: Date
  ): Promise<{
    grant: RemoteMcpOAuthGrant;
    data: RemoteMcpOAuthCredential["data"];
  } | null>;
  exchange(input: {
    kind: "code" | "refresh";
    hash: string;
    clientId: string;
    resource: string;
    redirectUri?: string;
    scopes?: string[];
    credentials: RemoteMcpOAuthCredential[];
    now: Date;
  }): Promise<{ grant: RemoteMcpOAuthGrant; scopes: string[] } | null>;
  getAccess(
    hash: string,
    now: Date
  ): Promise<{
    grant: RemoteMcpOAuthGrant;
    scopes: string[];
    expiresAt: Date;
  } | null>;
  revoke(hash: string, clientId: string, now: Date): Promise<void>;
}

type GrantRow = {
  id: string;
  user_id: string;
  client_id: string;
  resource: string;
  scopes: string[];
  expires_at: Date;
};
const mapGrant = (row: GrantRow): RemoteMcpOAuthGrant => ({
  id: row.id,
  userId: row.user_id,
  clientId: row.client_id,
  resource: row.resource,
  scopes: row.scopes,
  expiresAt: row.expires_at
});

export const createRemoteMcpOAuthRepository = (
  pool: pg.Pool
): RemoteMcpOAuthStore => {
  const transaction = async <T>(
    operation: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const value = await operation(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const insertCredential = async (
    client: pg.PoolClient,
    grantId: string,
    credential: RemoteMcpOAuthCredential
  ) => {
    await client.query(
      `insert into remote_mcp_oauth_credentials (secret_hash, grant_id, kind, expires_at, data) values ($1,$2,$3,$4,$5::jsonb)`,
      [
        credential.hash,
        grantId,
        credential.kind,
        credential.expiresAt,
        JSON.stringify(credential.data)
      ]
    );
  };
  return {
    async getClient(id) {
      const result = await pool.query<{ metadata: Record<string, unknown> }>(
        `select metadata from remote_mcp_oauth_clients where id = $1`,
        [id]
      );
      return result.rows[0]?.metadata;
    },
    async registerClient(id, metadata) {
      await pool.query(
        `insert into remote_mcp_oauth_clients (id, metadata) values ($1,$2::jsonb)`,
        [id, JSON.stringify(metadata)]
      );
    },
    async createRequest(hash, request, expiresAt) {
      await pool.query(
        `insert into remote_mcp_oauth_requests (secret_hash, client_id, data, expires_at) values ($1,$2,$3::jsonb,$4)`,
        [hash, request.clientId, JSON.stringify(request), expiresAt]
      );
    },
    async getRequest(hash, now) {
      const result = await pool.query<{
        data: RemoteMcpOAuthRequest;
        expires_at: Date;
      }>(
        `select data, expires_at from remote_mcp_oauth_requests where secret_hash = $1 and expires_at > $2 and consumed_at is null`,
        [hash, now]
      );
      const row = result.rows[0];
      return row ? { request: row.data, expiresAt: row.expires_at } : null;
    },
    async completeRequest(input) {
      return transaction(async (client) => {
        const user = await client.query(
          `select id from users where id = $1 and disabled_at is null and deleted_at is null`,
          [input.userId]
        );
        if (!user.rows[0]) return null;
        const pending = await client.query<{ data: RemoteMcpOAuthRequest }>(
          `update remote_mcp_oauth_requests set consumed_at = $2 where secret_hash = $1 and expires_at > $2 and consumed_at is null returning data`,
          [input.hash, input.now]
        );
        const request = pending.rows[0]?.data;
        if (!request) return null;
        if (input.approved) {
          await client.query(
            `insert into remote_mcp_oauth_grants (id,user_id,client_id,resource,scopes,expires_at) values ($1,$2,$3,$4,$5,$6)`,
            [
              input.grantId,
              input.userId,
              request.clientId,
              request.resource,
              request.scopes,
              input.grantExpiresAt
            ]
          );
          await insertCredential(client, input.grantId, {
            ...input.code,
            data: {
              scopes: request.scopes,
              codeChallenge: request.codeChallenge,
              redirectUri: request.redirectUri
            }
          });
          await client.query(
            `insert into audit_events (actor_user_id, owner_user_id, visibility, action, target_table, target_id, metadata) values ($1,$1,'personal','remote_mcp.oauth.granted','remote_mcp_oauth_grants',$2,$3::jsonb)`,
            [
              input.userId,
              input.grantId,
              JSON.stringify({
                clientId: request.clientId,
                resource: request.resource,
                scopes: request.scopes
              })
            ]
          );
        }
        return request;
      });
    },
    async getCode(hash, clientId, now) {
      const result = await pool.query<
        GrantRow & { data: RemoteMcpOAuthCredential["data"] }
      >(
        `select g.*, c.data from remote_mcp_oauth_credentials c join remote_mcp_oauth_grants g on g.id = c.grant_id join users u on u.id = g.user_id where c.secret_hash = $1 and c.kind = 'code' and g.client_id = $2 and c.expires_at > $3 and c.consumed_at is null and g.expires_at > $3 and g.revoked_at is null and u.disabled_at is null and u.deleted_at is null`,
        [hash, clientId, now]
      );
      const row = result.rows[0];
      return row ? { grant: mapGrant(row), data: row.data } : null;
    },
    async exchange(input) {
      return transaction(async (client) => {
        // Every family transition takes the same grant lock, including replay revocation.
        const result = await client.query<
          GrantRow & {
            data: RemoteMcpOAuthCredential["data"];
            consumed_at: Date | null;
            credential_expires_at: Date;
          }
        >(
          `select g.*, c.data, c.consumed_at, c.expires_at as credential_expires_at from remote_mcp_oauth_credentials c join remote_mcp_oauth_grants g on g.id = c.grant_id join users u on u.id = g.user_id where c.secret_hash = $1 and c.kind = $2 and g.client_id = $3 and g.resource = $4 and g.revoked_at is null and g.expires_at > $5 and u.disabled_at is null and u.deleted_at is null for update of g`,
          [input.hash, input.kind, input.clientId, input.resource, input.now]
        );
        const row = result.rows[0];
        if (!row) return null;
        // Read the credential again after acquiring the family lock: another
        // transaction may have rotated it while this SELECT was waiting.
        const current = await client.query<{ consumed_at: Date | null }>(
          `select consumed_at from remote_mcp_oauth_credentials where secret_hash = $1`,
          [input.hash]
        );
        if (current.rows[0]?.consumed_at) {
          if (input.kind === "refresh") {
            await client.query(
              `update remote_mcp_oauth_grants set revoked_at = $2 where id = $1`,
              [row.id, input.now]
            );
            await client.query(
              `insert into audit_events (actor_user_id, owner_user_id, visibility, action, target_table, target_id, metadata) values ($1,$1,'personal','remote_mcp.oauth.refresh_replay','remote_mcp_oauth_grants',$2,'{}'::jsonb)`,
              [row.user_id, row.id]
            );
          }
          return null;
        }
        if (
          row.credential_expires_at <= input.now ||
          (input.kind === "code" && input.redirectUri !== row.data.redirectUri)
        )
          return null;
        const scopes = input.scopes ?? row.data.scopes;
        if (
          !scopes.length ||
          scopes.some((scope) => !row.data.scopes.includes(scope))
        )
          return null;
        await client.query(
          `update remote_mcp_oauth_credentials set consumed_at = $2 where secret_hash = $1`,
          [input.hash, input.now]
        );
        for (const credential of input.credentials)
          await insertCredential(client, row.id, {
            ...credential,
            data: { scopes },
            expiresAt: new Date(
              Math.min(credential.expiresAt.getTime(), row.expires_at.getTime())
            )
          });
        return { grant: mapGrant(row), scopes };
      });
    },
    async getAccess(hash, now) {
      const result = await pool.query<
        GrantRow & {
          data: RemoteMcpOAuthCredential["data"];
          credential_expires_at: Date;
        }
      >(
        `select g.*, c.data, c.expires_at as credential_expires_at from remote_mcp_oauth_credentials c join remote_mcp_oauth_grants g on g.id = c.grant_id join users u on u.id = g.user_id where c.secret_hash = $1 and c.kind = 'access' and c.expires_at > $2 and c.consumed_at is null and g.expires_at > $2 and g.revoked_at is null and u.disabled_at is null and u.deleted_at is null`,
        [hash, now]
      );
      const row = result.rows[0];
      return row
        ? {
            grant: mapGrant(row),
            scopes: row.data.scopes,
            expiresAt: row.credential_expires_at
          }
        : null;
    },
    async revoke(hash, clientId, now) {
      await transaction(async (client) => {
        const grant = await client.query<{ id: string; user_id: string }>(
          `select g.id, g.user_id from remote_mcp_oauth_grants g join remote_mcp_oauth_credentials c on c.grant_id = g.id where c.secret_hash = $1 and g.client_id = $2 and g.revoked_at is null for update of g`,
          [hash, clientId]
        );
        const row = grant.rows[0];
        if (!row) return;
        await client.query(
          `update remote_mcp_oauth_grants set revoked_at = $2 where id = $1`,
          [row.id, now]
        );
        await client.query(
          `insert into audit_events (actor_user_id, owner_user_id, visibility, action, target_table, target_id, metadata) values ($1,$1,'personal','remote_mcp.oauth.revoked','remote_mcp_oauth_grants',$2,'{}'::jsonb)`,
          [row.user_id, row.id]
        );
      });
    }
  };
};
