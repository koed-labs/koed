import { z } from "zod";

const id = z.string().uuid();
const when = z.string().datetime({ offset: true });
const teamOrigin = z
  .object({
    actorKind: z.enum(["person", "agent_on_behalf"]).nullable(),
    accessMode: z.enum(["ask_first", "full_access"]).nullable(),
    agentDisplayName: z.string().nullable()
  })
  .strict();
const personalOrigin = teamOrigin
  .extend({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not_recorded") }).strict(),
      z.object({ kind: z.literal("share_window") }).strict(),
      z.object({ kind: z.literal("conversation"), conversationId: id }).strict()
    ])
  })
  .strict();

const person = z
  .object({ id: id.nullable(), displayName: z.string() })
  .strict();
const access = z.enum(["edit", "view"]);

export const teamSharingInviteSchema = z
  .object({
    kind: z.literal("invitation"),
    id,
    teamId: id,
    workspaceProjectId: id.nullable(),
    teamName: z.string().optional(),
    workspaceName: z.string().nullable().optional(),
    person,
    role: z.enum(["owner", "admin", "member"]),
    access,
    status: z.literal("invited"),
    since: when,
    origin: teamOrigin,
    canCancel: z.boolean()
  })
  .strict();

export const teamSharingAccessSchema = z
  .object({
    kind: z.literal("workspace_access"),
    teamId: id,
    teamWorkspaceId: id,
    workspaceProjectId: id.nullable(),
    teamName: z.string().optional(),
    workspaceName: z.string().optional(),
    person,
    how: z.enum(["direct", "through_group"]),
    access,
    status: z.literal("joined"),
    since: when,
    version: z.number().int().positive(),
    origin: teamOrigin,
    canRemove: z.boolean()
  })
  .strict();

export const teamSharingProjectSchema = z
  .object({
    id,
    teamId: id,
    teamWorkspaceId: id,
    name: z.string(),
    owner: person,
    group: z.object({ id, name: z.string() }).strict(),
    ownedByMe: z.boolean(),
    joinedByMe: z.boolean().optional(),
    members: z.array(teamSharingAccessSchema),
    invitations: z.array(teamSharingInviteSchema),
    counts: z
      .object({
        members: z.number().int().nonnegative(),
        invitations: z.number().int().nonnegative()
      })
      .strict(),
    contentCounts: z
      .object({
        sources: z.number().int().nonnegative(),
        toDos: z.number().int().nonnegative(),
        chatSummaries: z.number().int().nonnegative(),
        sharedMemoryItems: z.number().int().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();

export const teamSharingReadSchema = z
  .object({
    projects: z.array(teamSharingProjectSchema),
    invitations: z.array(teamSharingInviteSchema),
    workspaceAccess: z.array(teamSharingAccessSchema)
  })
  .strict();

const personalInvitation = teamSharingInviteSchema
  .extend({ origin: personalOrigin })
  .strict();
const personalAccess = teamSharingAccessSchema
  .extend({ origin: personalOrigin })
  .strict();
const personalProject = teamSharingProjectSchema
  .extend({
    members: z.array(personalAccess),
    invitations: z.array(personalInvitation)
  })
  .strict();
export const personalSharingReadSchema = z
  .object({
    projects: z.array(personalProject),
    invitations: z.array(personalInvitation),
    workspaceAccess: z.array(personalAccess)
  })
  .strict();

export const sharingIncomingInvitationSchema = z
  .object({
    id,
    team: z.object({ id, name: z.string() }).strict(),
    workspace: z.object({ id, name: z.string() }).strict(),
    project: z.object({ id, name: z.string() }).strict().nullable(),
    inviter: z
      .object({
        displayName: z.string().nullable(),
        agentDisplayName: z.string().nullable()
      })
      .strict(),
    access,
    expiresAt: when
  })
  .strict();

export const sharingBackendSchema = z.discriminatedUnion("status", [
  z
    .object({
      backendId: z.string().min(1),
      status: z.literal("available"),
      reachedAt: when,
      data: personalSharingReadSchema,
      incomingInvitations: z.array(sharingIncomingInvitationSchema)
    })
    .strict(),
  z
    .object({
      backendId: z.string().min(1),
      status: z.literal("unavailable"),
      lastReachedAt: when.nullable(),
      reason: z.enum([
        "unenrolled",
        "route_disabled",
        "unreachable",
        "unauthorized",
        "invalid_response"
      ])
    })
    .strict()
]);

export const sharingOverviewSchema = z
  .object({
    backends: z.array(sharingBackendSchema)
  })
  .strict();

export type TeamSharingRead = z.infer<typeof teamSharingReadSchema>;
export type PersonalSharingRead = z.infer<typeof personalSharingReadSchema>;
export type SharingOverview = z.infer<typeof sharingOverviewSchema>;
