ALTER TYPE "public"."invite_lifecycle" ADD VALUE 'declined' BEFORE 'revoked';--> statement-breakpoint
ALTER TABLE "team_invites" DROP CONSTRAINT "team_invites_lifecycle_shape_check";--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "recipient_user_id" uuid;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "recipient_leave_generation" integer;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "issuance_membership_version" integer;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "issuance_membership_status" "team_membership_status";--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "issuance_disabled_reason" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "inviter_agent_display_name" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "leave_generation" integer;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_recipient_generation_check" CHECK (("team_invites"."recipient_user_id" is null and "team_invites"."recipient_leave_generation" is null) or ("team_invites"."recipient_user_id" is not null and "team_invites"."recipient_leave_generation" is not null and "team_invites"."recipient_leave_generation" >= 0));--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_issuance_membership_check" CHECK (("team_invites"."issuance_membership_version" is null and "team_invites"."issuance_membership_status" is null and "team_invites"."issuance_disabled_reason" is null) or ("team_invites"."issuance_membership_version" is not null and "team_invites"."issuance_membership_version" > 0 and "team_invites"."issuance_membership_status" is not null and "team_invites"."issuance_membership_status" = 'disabled' and "team_invites"."issuance_disabled_reason" is not null));--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_lifecycle_shape_check" CHECK ((
        "team_invites"."lifecycle" = 'pending'
        and "team_invites"."accepted_at" is null
        and "team_invites"."declined_at" is null
        and "team_invites"."revoked_at" is null
      ) or (
        "team_invites"."lifecycle" = 'accepted'
        and "team_invites"."accepted_at" is not null
        and "team_invites"."declined_at" is null
        and "team_invites"."revoked_at" is null
      ) or (
        "team_invites"."lifecycle"::text = 'declined'
        and "team_invites"."accepted_at" is null
        and "team_invites"."declined_at" is not null
        and "team_invites"."revoked_at" is null
      ) or (
        "team_invites"."lifecycle" = 'revoked'
        and "team_invites"."accepted_at" is null
        and "team_invites"."declined_at" is null
        and "team_invites"."revoked_at" is not null
      ) or (
        "team_invites"."lifecycle" = 'expired'
        and "team_invites"."accepted_at" is null
        and "team_invites"."declined_at" is null
        and "team_invites"."revoked_at" is null
      ));--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_leave_generation_check" CHECK ("team_memberships"."leave_generation" is null or "team_memberships"."leave_generation" >= 0);