import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { KoedDb } from "./connection.js";
import { userSessions, users } from "./schema.js";
import type { UserRecord, UserSessionContext } from "./types.js";
import { mapUserRecord } from "./user-api-token-repository.js";

export const createAuthSessionRepository = (db: KoedDb) => ({
  async createSession(
    userId: string,
    sessionHash: string,
    expiresAt: Date
  ): Promise<void> {
    await db.insert(userSessions).values({
      userId,
      sessionHash,
      expiresAt
    });
  },

  async getSessionUser(sessionHash: string): Promise<UserRecord | null> {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.sessionHash, sessionHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, sql`now()`),
          isNull(users.disabledAt),
          isNull(users.deletedAt)
        )
      )
      .limit(1);

    return rows[0] ? mapUserRecord(rows[0]) : null;
  },

  async getSessionContext(
    sessionHash: string
  ): Promise<UserSessionContext | null> {
    const rows = await db
      .select({
        sessionId: userSessions.id,
        createdAt: userSessions.createdAt,
        expiresAt: userSessions.expiresAt,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.sessionHash, sessionHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, sql`now()`),
          isNull(users.disabledAt),
          isNull(users.deletedAt)
        )
      )
      .limit(1);

    const row = rows[0];
    return row
      ? {
          sessionId: row.sessionId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          user: mapUserRecord(row)
        }
      : null;
  },

  async revokeSession(sessionHash: string): Promise<void> {
    await db
      .update(userSessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userSessions.sessionHash, sessionHash),
          isNull(userSessions.revokedAt)
        )
      );
  }
});
