import { and, eq, isNull, sql } from "drizzle-orm";
import { auditEventValues } from "./audit-repository.js";
import type { KoedDb } from "./connection.js";
import {
  auditEvents,
  externalAuthIdentities,
  externalAuthOrganizations,
  teams,
  users
} from "./schema.js";
import type {
  ExternalAuthIdentityRecord,
  ExternalAuthOrganizationRecord,
  ExternalAuthSessionResult,
  UserRecord
} from "./types.js";
import { mapUserRecord } from "./user-api-token-repository.js";

const defaultProviderEnvironment = "default";

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const requireProviderId = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw Object.assign(new Error(`${field} is required`), {
      statusCode: 400
    });
  }
  return trimmed;
};

const scrubProviderProfile = (
  value: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("token") ||
      normalized.includes("secret") ||
      normalized.includes("credential")
    ) {
      continue;
    }
    scrubbed[key] = item;
  }
  return scrubbed;
};

const mapExternalAuthIdentity = (row: {
  id: string;
  provider: "workos_authkit";
  providerEnvironment: string;
  providerUserId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  status: "linked" | "disabled";
  profile: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
}): ExternalAuthIdentityRecord => ({
  id: row.id,
  provider: row.provider,
  providerEnvironment: row.providerEnvironment,
  providerUserId: row.providerUserId,
  userId: row.userId,
  email: row.email,
  emailVerified: row.emailVerified,
  displayName: row.displayName,
  status: row.status,
  profile: row.profile,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null
});

const mapExternalAuthOrganization = (row: {
  id: string;
  provider: "workos_authkit";
  providerEnvironment: string;
  providerOrganizationId: string;
  teamId: string;
  name: string | null;
  status: "linked" | "disabled";
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
}): ExternalAuthOrganizationRecord => ({
  id: row.id,
  provider: row.provider,
  providerEnvironment: row.providerEnvironment,
  providerOrganizationId: row.providerOrganizationId,
  teamId: row.teamId,
  name: row.name,
  status: row.status,
  metadata: row.metadata,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null
});

const findActiveUser = async (
  db: KoedDb,
  userId: string
): Promise<UserRecord | null> => {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash
    })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNull(users.disabledAt),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  return rows[0] ? mapUserRecord(rows[0]) : null;
};

export const createExternalAuthRepository = (db: KoedDb) => ({
  async getExternalAuthIdentity(input: {
    provider: "workos_authkit";
    providerEnvironment?: string;
    providerUserId: string;
  }): Promise<ExternalAuthIdentityRecord | null> {
    const rows = await db
      .select()
      .from(externalAuthIdentities)
      .where(
        and(
          eq(externalAuthIdentities.provider, input.provider),
          eq(
            externalAuthIdentities.providerEnvironment,
            input.providerEnvironment ?? defaultProviderEnvironment
          ),
          eq(
            externalAuthIdentities.providerUserId,
            requireProviderId(input.providerUserId, "providerUserId")
          )
        )
      )
      .limit(1);

    return rows[0] ? mapExternalAuthIdentity(rows[0]) : null;
  },

  async getVerifiedExternalAuthIdentityForUser(
    userId: string
  ): Promise<ExternalAuthIdentityRecord | null> {
    const rows = await db
      .select({ identity: externalAuthIdentities })
      .from(externalAuthIdentities)
      .innerJoin(users, eq(users.id, externalAuthIdentities.userId))
      .where(
        and(
          eq(externalAuthIdentities.userId, userId),
          eq(externalAuthIdentities.status, "linked"),
          eq(externalAuthIdentities.emailVerified, true),
          isNull(users.disabledAt),
          isNull(users.deletedAt),
          sql`lower(trim(${externalAuthIdentities.email})) = lower(trim(${users.email}))`
        )
      )
      .orderBy(sql`${externalAuthIdentities.lastSeenAt} desc nulls last`)
      .limit(1);

    return rows[0] ? mapExternalAuthIdentity(rows[0].identity) : null;
  },

  async upsertExternalAuthSession(input: {
    provider: "workos_authkit";
    providerEnvironment?: string;
    providerUserId: string;
    email: string;
    emailVerified?: boolean;
    displayName?: string | null;
    profile?: Record<string, unknown>;
    organization?: {
      providerOrganizationId: string;
      name?: string | null;
      metadata?: Record<string, unknown>;
    } | null;
  }): Promise<ExternalAuthSessionResult> {
    const providerEnvironment =
      input.providerEnvironment ?? defaultProviderEnvironment;
    const providerUserId = requireProviderId(
      input.providerUserId,
      "providerUserId"
    );
    const email = normalizeEmail(input.email);
    if (!email) {
      throw Object.assign(new Error("email is required"), { statusCode: 400 });
    }

    return db.transaction(async (tx) => {
      const existingIdentityRows = await tx
        .select()
        .from(externalAuthIdentities)
        .where(
          and(
            eq(externalAuthIdentities.provider, input.provider),
            eq(externalAuthIdentities.providerEnvironment, providerEnvironment),
            eq(externalAuthIdentities.providerUserId, providerUserId)
          )
        )
        .limit(1);
      const existingIdentity = existingIdentityRows[0] ?? null;

      if (existingIdentity?.status === "disabled") {
        throw Object.assign(new Error("External identity is disabled"), {
          statusCode: 403
        });
      }

      let user: UserRecord | null = existingIdentity
        ? await findActiveUser(tx, existingIdentity.userId)
        : null;
      let createdUser = false;

      if (!user) {
        const sameEmailRows = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, email), isNull(users.deletedAt)))
          .limit(1);
        if (
          sameEmailRows[0] &&
          existingIdentity &&
          sameEmailRows[0].id === existingIdentity.userId
        ) {
          throw Object.assign(
            new Error(
              "External identity is linked to an inactive Koed account"
            ),
            { statusCode: 403 }
          );
        }
        if (sameEmailRows[0] && !existingIdentity) {
          throw Object.assign(
            new Error(
              "External identity is not linked to the existing Koed account"
            ),
            { statusCode: 409 }
          );
        }

        const userRows = await tx
          .insert(users)
          .values({
            email,
            displayName: input.displayName?.trim() || null,
            passwordHash: null
          })
          .returning({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            passwordHash: users.passwordHash
          });
        user = mapUserRecord(userRows[0]!);
        createdUser = true;
      }

      const identityRows = await tx
        .insert(externalAuthIdentities)
        .values({
          provider: input.provider,
          providerEnvironment,
          providerUserId,
          userId: user.id,
          email,
          emailVerified: input.emailVerified ?? false,
          displayName: input.displayName?.trim() || null,
          status: "linked",
          profile: scrubProviderProfile(input.profile),
          lastSeenAt: sql`now()`
        })
        .onConflictDoUpdate({
          target: [
            externalAuthIdentities.provider,
            externalAuthIdentities.providerEnvironment,
            externalAuthIdentities.providerUserId
          ],
          set: {
            userId: user.id,
            email,
            emailVerified: input.emailVerified ?? false,
            displayName: input.displayName?.trim() || null,
            profile: scrubProviderProfile(input.profile),
            updatedAt: sql`now()`,
            lastSeenAt: sql`now()`
          }
        })
        .returning();
      const identity = mapExternalAuthIdentity(identityRows[0]!);

      let organization: ExternalAuthOrganizationRecord | null = null;
      const providerOrganizationId = input.organization?.providerOrganizationId
        ? requireProviderId(
            input.organization.providerOrganizationId,
            "providerOrganizationId"
          )
        : null;
      if (providerOrganizationId) {
        const existingOrganizationRows = await tx
          .select()
          .from(externalAuthOrganizations)
          .where(
            and(
              eq(externalAuthOrganizations.provider, input.provider),
              eq(
                externalAuthOrganizations.providerEnvironment,
                providerEnvironment
              ),
              eq(
                externalAuthOrganizations.providerOrganizationId,
                providerOrganizationId
              )
            )
          )
          .limit(1);
        const existingOrganization = existingOrganizationRows[0] ?? null;
        if (existingOrganization?.status === "disabled") {
          throw Object.assign(new Error("External organization is disabled"), {
            statusCode: 403
          });
        }
        const teamId =
          existingOrganization?.teamId ??
          (
            await tx
              .insert(teams)
              .values({
                name: input.organization?.name?.trim() || providerOrganizationId
              })
              .returning({ id: teams.id })
          )[0]!.id;
        const organizationRows = await tx
          .insert(externalAuthOrganizations)
          .values({
            provider: input.provider,
            providerEnvironment,
            providerOrganizationId,
            teamId,
            name: input.organization?.name?.trim() || null,
            status: "linked",
            metadata: input.organization?.metadata ?? {},
            lastSeenAt: sql`now()`
          })
          .onConflictDoUpdate({
            target: [
              externalAuthOrganizations.provider,
              externalAuthOrganizations.providerEnvironment,
              externalAuthOrganizations.providerOrganizationId
            ],
            set: {
              name: input.organization?.name?.trim() || null,
              metadata: input.organization?.metadata ?? {},
              updatedAt: sql`now()`,
              lastSeenAt: sql`now()`
            }
          })
          .returning();
        organization = mapExternalAuthOrganization(organizationRows[0]!);
      }

      await tx.insert(auditEvents).values(
        auditEventValues({
          actorUserId: user.id,
          ownerUserId: user.id,
          visibility: "personal",
          action: createdUser
            ? "external_auth.user_created"
            : "external_auth.identity_seen",
          targetTable: "external_auth_identities",
          targetId: identity.id,
          metadata: {
            provider: input.provider,
            providerEnvironment,
            providerUserId,
            organizationId: organization?.id ?? null,
            providerOrganizationId: providerOrganizationId ?? null
          }
        })
      );

      return { user, identity, organization, createdUser };
    });
  }
});
