import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { KoedDb } from "./connection.js";
import { apiTokens, users } from "./schema.js";
import type { ApiTokenRecord, CreateUserInput, UserRecord } from "./types.js";

export const mapUserRecord = (row: {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
}): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  passwordHash: row.passwordHash
});

const mapApiTokenRecord = (row: {
  id: string;
  ownerUserId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}): ApiTokenRecord => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  name: row.name,
  tokenPrefix: row.tokenPrefix,
  scopes: row.scopes,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null
});

export const createUserApiTokenRepository = (db: KoedDb) => {
  const getUser = async (userId: string): Promise<UserRecord | null> => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)))
      .limit(1);

    return rows[0] ? mapUserRecord(rows[0]) : null;
  };

  return {
    async createUser(input: CreateUserInput): Promise<{ id: string }> {
      const rows = await db
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          displayName: input.displayName ?? null,
          passwordHash: input.passwordHash ?? null
        })
        .returning({ id: users.id });

      return { id: rows[0]!.id };
    },

    async findUserByEmail(email: string): Promise<UserRecord | null> {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          passwordHash: users.passwordHash
        })
        .from(users)
        .where(
          and(eq(users.email, email.toLowerCase()), isNull(users.disabledAt))
        )
        .limit(1);

      return rows[0] ? mapUserRecord(rows[0]) : null;
    },

    getUser,

    async createApiToken(input: {
      ownerUserId: string;
      name: string;
      tokenHash: string;
      tokenPrefix: string;
      scopes?: string[];
      expiresAt?: Date;
    }): Promise<ApiTokenRecord> {
      const rows = await db
        .insert(apiTokens)
        .values({
          ownerUserId: input.ownerUserId,
          name: input.name,
          tokenHash: input.tokenHash,
          tokenPrefix: input.tokenPrefix,
          scopes: input.scopes ?? [],
          expiresAt: input.expiresAt ?? null
        })
        .returning();

      return mapApiTokenRecord(rows[0]!);
    },

    async listApiTokens(userId: string): Promise<ApiTokenRecord[]> {
      const rows = await db
        .select()
        .from(apiTokens)
        .where(
          and(eq(apiTokens.ownerUserId, userId), isNull(apiTokens.revokedAt))
        )
        .orderBy(desc(apiTokens.createdAt));

      return rows.map(mapApiTokenRecord);
    },

    async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
      const rows = await db
        .update(apiTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(apiTokens.id, tokenId),
            eq(apiTokens.ownerUserId, userId),
            isNull(apiTokens.revokedAt)
          )
        )
        .returning({ id: apiTokens.id });

      return rows.length > 0;
    },

    async getApiTokenUser(tokenHash: string): Promise<UserRecord | null> {
      const tokenRows = await db
        .update(apiTokens)
        .set({ lastUsedAt: sql`now()` })
        .where(
          and(
            eq(apiTokens.tokenHash, tokenHash),
            isNull(apiTokens.revokedAt),
            or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`))
          )
        )
        .returning({ ownerUserId: apiTokens.ownerUserId });

      const token = tokenRows[0];
      return token ? getUser(token.ownerUserId) : null;
    }
  };
};
