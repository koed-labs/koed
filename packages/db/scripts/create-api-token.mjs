#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createApiTokenBootstrap,
  formatCreateApiTokenResult,
  helpText,
  loadRootEnv,
  UsageError
} from "../../../scripts/api-token-bootstrap-lib.mjs";

const { Pool } = pg;
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(packageDir, "../..");

loadRootEnv(rootDir, process.env);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

const repo = {
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
  }
};

try {
  if (
    process.argv.slice(2).includes("--help") ||
    process.argv.slice(2).includes("-h")
  ) {
    process.stdout.write(helpText);
    process.exit(0);
  }

  const result = await createApiTokenBootstrap({
    repo,
    environment: process.env,
    argv: process.argv.slice(2)
  });
  console.log(formatCreateApiTokenResult(result));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  await pool.end().catch(() => {});
}
