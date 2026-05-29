import pg from "pg";

const { Pool } = pg;

export const createApiTokenScriptRepo = (connectionString) => {
  const pool = new Pool({ connectionString });

  const mapUser = (row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash
  });

  const mapApiToken = (row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null
  });

  return {
    async close() {
      await pool.end();
    },

    async findUserByEmail(email) {
      const result = await pool.query(
        `
          select id, email, display_name, password_hash
          from users
          where email = $1 and disabled_at is null
          limit 1
        `,
        [email.toLowerCase()]
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async createUser(input) {
      const result = await pool.query(
        `
          insert into users (email, display_name, password_hash)
          values ($1, $2, $3)
          returning id, email, display_name, password_hash
        `,
        [
          input.email.toLowerCase(),
          input.displayName ?? null,
          input.passwordHash ?? null
        ]
      );
      return mapUser(result.rows[0]);
    },

    async createApiToken(input) {
      const result = await pool.query(
        `
          insert into api_tokens (owner_user_id, name, token_hash, token_prefix, scopes, expires_at)
          values ($1, $2, $3, $4, $5, $6)
          returning id, owner_user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
        `,
        [
          input.ownerUserId,
          input.name,
          input.tokenHash,
          input.tokenPrefix,
          input.scopes ?? [],
          input.expiresAt ?? null
        ]
      );
      return mapApiToken(result.rows[0]);
    },

    async listApiTokens(userId) {
      const result = await pool.query(
        `
          select id, owner_user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
          from api_tokens
          where owner_user_id = $1 and revoked_at is null
          order by created_at desc
        `,
        [userId]
      );
      return result.rows.map(mapApiToken);
    },

    async revokeApiToken(userId, tokenId) {
      const result = await pool.query(
        `
          update api_tokens
          set revoked_at = now()
          where id = $1 and owner_user_id = $2 and revoked_at is null
        `,
        [tokenId, userId]
      );
      return (result.rowCount ?? 0) > 0;
    }
  };
};
