import { z } from "zod";

export const teamIdParamsSchema = z.object({
  teamId: z.string().uuid()
});

export const teamWorkspaceIdParamsSchema = z.object({
  teamWorkspaceId: z.string().uuid()
});

export const teamMemberParamsSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid()
});

export const teamAuditEventsQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

export const createTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(120)
  })
  .strict();

export const teamRoleSchema = z.enum(["owner", "admin", "member"]);

export const teamMembershipStatusSchema = z.enum([
  "invited",
  "enabled",
  "disabled"
]);

export const teamWorkspaceAccessSchema = z.enum(["disabled", "read", "write"]);

export const teamEntitlementStatusSchema = z.enum([
  "active",
  "grace",
  "suspended",
  "revoked"
]);

export const upsertTeamMemberSchema = z
  .object({
    userId: z.string().uuid(),
    role: teamRoleSchema,
    status: teamMembershipStatusSchema.optional()
  })
  .strict();

export const createTeamWorkspaceSchema = z
  .object({
    teamId: z.string().uuid(),
    name: z.string().trim().min(1).max(120)
  })
  .strict();

export const setTeamWorkspaceAccessSchema = z
  .object({
    userId: z.string().uuid(),
    access: teamWorkspaceAccessSchema
  })
  .strict();

export const createTeamSessionShareGrantSchema = z
  .object({
    sessionId: z.string().uuid()
  })
  .strict();

export const teamSessionShareGrantIdParamsSchema = z.object({
  teamWorkspaceId: z.string().uuid(),
  shareGrantId: z.string().uuid()
});

export const listTeamSessionShareGrantsQuerySchema = z
  .object({
    includeRevoked: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

export const revokeTeamSessionShareGrantSchema = z
  .object({
    reason: z.string().trim().min(1).max(240).nullable().optional()
  })
  .strict();

export const setTeamEntitlementStateSchema = z
  .object({
    status: teamEntitlementStatusSchema,
    reason: z.string().trim().min(1).max(240).nullable().optional()
  })
  .strict();

export const setTeamBillingSeatPolicySchema = z
  .object({
    seatLimit: z.coerce.number().int().min(0).nullable()
  })
  .strict();

export const createTeamInviteSchema = z
  .object({
    email: z.string().trim().email(),
    role: teamRoleSchema,
    ttlHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24 * 7)
  })
  .strict();

export const acceptTeamInviteSchema = z
  .object({
    inviteToken: z.string().trim().min(1),
    email: z.string().trim().email().optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(8).optional()
  })
  .strict();
