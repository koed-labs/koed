import { z } from "zod";

const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const boundedNameSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.normalize("NFC"))
  .refine((value) => [...value].length <= 80, {
    message: "Name must contain at most 80 Unicode code points"
  });

const workspaceDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.normalize("NFC"))
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024, {
    message: "Description must contain at most 1024 UTF-8 bytes"
  });

export const teamIdParamsSchema = z.object({ teamId: z.string().uuid() });

export const teamWorkspaceIdParamsSchema = z.object({
  teamWorkspaceId: z.string().uuid()
});

export const teamMemberParamsSchema = z.object({
  teamId: z.string().uuid(),
  userId: z.string().uuid()
});

export const teamInviteIdParamsSchema = z.object({
  teamId: z.string().uuid(),
  inviteId: z.string().uuid()
});

export const teamAuditEventsQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

export const createTeamSchema = z.object({ name: boundedNameSchema }).strict();

export const teamRoleSchema = z.enum(["owner", "admin", "member"]);

export const teamWorkspaceAccessSchema = z.enum(["disabled", "read", "write"]);

export const teamEntitlementStatusSchema = z.enum([
  "active",
  "grace",
  "suspended",
  "revoked"
]);

export const expectedVersionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

export const updateTeamMemberRoleSchema = z
  .object({
    role: teamRoleSchema,
    expectedVersion: z.number().int().positive()
  })
  .strict();

export const createTeamWorkspaceSchema = z
  .object({
    teamId: z.string().uuid(),
    name: boundedNameSchema,
    description: workspaceDescriptionSchema.nullable().optional()
  })
  .strict();

export const listTeamWorkspacesQuerySchema = z
  .object({
    includeArchived: booleanQuerySchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
  })
  .strict();

export const setTeamWorkspaceAccessSchema = z
  .object({
    userId: z.string().uuid(),
    access: teamWorkspaceAccessSchema,
    canShareOwnedMemory: z.boolean().optional(),
    expectedVersion: z.number().int().positive().nullable()
  })
  .strict();

export const setTeamEntitlementStateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: teamEntitlementStatusSchema,
    reason: z.string().trim().min(1).max(240).nullable().optional()
  })
  .strict();

export const setTeamBillingSeatPolicySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    seatLimit: z.coerce.number().int().min(0).nullable()
  })
  .strict();

export const createTeamInviteSchema = z
  .object({
    defaultTeamWorkspaceId: z.string().uuid(),
    defaultWorkspaceAccess: z.enum(["read", "write"]).default("write"),
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

export const listTeamInvitesQuerySchema = z
  .object({
    includeRevoked: booleanQuerySchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).max(4096).optional()
  })
  .strict();

export const acceptTeamInviteSchema = z
  .object({ inviteToken: z.string().trim().min(1) })
  .strict();
