import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { KoedDb } from "./connection.js";
import { userSessions, users } from "./schema.js";
import type { UserRecord } from "./types.js";
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
          isNull(users.disabledAt)
        )
      )
      .limit(1);

    return rows[0] ? mapUserRecord(rows[0]) : null;
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
