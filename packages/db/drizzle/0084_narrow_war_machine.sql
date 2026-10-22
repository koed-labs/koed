CREATE TABLE "collaboration_curated_grant_source_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"original_pending_share_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"curated_material_commitment_hash" text NOT NULL,
	"local_session_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_deployment_protocol_id" uuid NOT NULL,
	"source_owner_principal_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"mode" "shared_memory_consent_mode" DEFAULT 'continuous' NOT NULL,
	"requested_generation" bigint DEFAULT 1 NOT NULL,
	"delivered_generation" bigint DEFAULT 0 NOT NULL,
	"claimed_generation" bigint,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"next_expiry_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_curated_grant_source_work_unique" UNIQUE("enrollment_id","original_pending_share_id"),
	CONSTRAINT "csm_curated_grant_source_work_binding_check" CHECK ("collaboration_curated_grant_source_work"."mode" = 'continuous'
        and "collaboration_curated_grant_source_work"."preview_hash" ~ '^[0-9a-f]{64}$'
        and "collaboration_curated_grant_source_work"."curated_material_commitment_hash" ~ '^[0-9a-f]{64}$'
        and "collaboration_curated_grant_source_work"."requested_generation" >= "collaboration_curated_grant_source_work"."delivered_generation"
        and "collaboration_curated_grant_source_work"."delivered_generation" >= 0
        and ("collaboration_curated_grant_source_work"."claimed_generation" is null or
          ("collaboration_curated_grant_source_work"."claimed_generation" > "collaboration_curated_grant_source_work"."delivered_generation"
           and "collaboration_curated_grant_source_work"."claimed_generation" <= "collaboration_curated_grant_source_work"."requested_generation"))
        and "collaboration_curated_grant_source_work"."state" in ('pending','processing','failed','idle')
        and "collaboration_curated_grant_source_work"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "consent_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "preview_hash" text;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "curated_material_commitment_hash" text;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "team_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "curated_material_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "curated_material_commitment_hash" text;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "curated_source_update_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "collaboration_curated_grant_source_work" ADD CONSTRAINT "collaboration_curated_grant_source_work_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csm_curated_grant_source_work_claim_idx" ON "collaboration_curated_grant_source_work" USING btree ("state","available_at","id");--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_curated_binding_check" CHECK (("collaboration_pending_share_source_work"."preview_hash" is null or "collaboration_pending_share_source_work"."preview_hash" ~ '^[0-9a-f]{64}$')
        and ("collaboration_pending_share_source_work"."curated_material_commitment_hash" is null or "collaboration_pending_share_source_work"."curated_material_commitment_hash" ~ '^[0-9a-f]{64}$')
        and ("collaboration_pending_share_source_work"."include_curated_memory" = false or
          ("collaboration_pending_share_source_work"."consent_id" is not null and "collaboration_pending_share_source_work"."preview_hash" is not null
           and "collaboration_pending_share_source_work"."curated_material_commitment_hash" is not null
           and "collaboration_pending_share_source_work"."team_workspace_id" is not null)));--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_curated_receipt_check" CHECK ("pending_share_operations"."curated_material_receipt" is null or coalesce((
        "pending_share_operations"."include_curated_memory" = true
        and jsonb_typeof("pending_share_operations"."curated_material_receipt") = 'object'
        and ("pending_share_operations"."curated_material_receipt"->>'materialHash') ~ '^[0-9a-f]{64}$'
        and ("pending_share_operations"."curated_material_receipt"->>'commitmentHash') ~ '^[0-9a-f]{64}$'
        and ("pending_share_operations"."curated_material_receipt"->>'previewHash') = "pending_share_operations"."preview_hash"
        and ("pending_share_operations"."curated_material_receipt"->>'consentId') = "pending_share_operations"."consent_id"::text
        and ("pending_share_operations"."curated_material_receipt"->>'sourceRevision')::bigint = "pending_share_operations"."source_revision"
        and ("pending_share_operations"."curated_material_receipt"->>'itemCount')::integer between 0 and 100
        and ((("pending_share_operations"."curated_material_receipt"->>'itemCount')::integer = 0
             and "pending_share_operations"."curated_material_receipt"->>'artifactId' is null)
          or (("pending_share_operations"."curated_material_receipt"->>'itemCount')::integer > 0
             and ("pending_share_operations"."curated_material_receipt"->>'artifactId') ~ '^[0-9a-f-]{36}$'))
      ), false));--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_curated_commitment_check" CHECK ("shared_memory_candidate_previews"."curated_material_commitment_hash" is null
        or "shared_memory_candidate_previews"."curated_material_commitment_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_curated_update_receipt_check" CHECK ("team_memory_share_grants"."curated_source_update_receipt" is null or coalesce((
        "team_memory_share_grants"."include_curated_memory" = true
        and "team_memory_share_grants"."mode" = 'continuous'
        and jsonb_typeof("team_memory_share_grants"."curated_source_update_receipt") = 'object'
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'generation')::bigint > 0
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'sourceRevision')::bigint >= 0
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'itemCount')::integer between 0 and 100
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'materialHash') ~ '^[0-9a-f]{64}$'
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'commitmentHash') ~ '^[0-9a-f]{64}$'
        and ("team_memory_share_grants"."curated_source_update_receipt"->>'updateHash') ~ '^[0-9a-f]{64}$'
        and ((("team_memory_share_grants"."curated_source_update_receipt"->>'itemCount')::integer = 0
          and "team_memory_share_grants"."curated_source_update_receipt"->>'artifactId' is null
          and "team_memory_share_grants"."curated_source_update_receipt"->>'previewId' is null)
         or (("team_memory_share_grants"."curated_source_update_receipt"->>'itemCount')::integer > 0
          and ("team_memory_share_grants"."curated_source_update_receipt"->>'artifactId') ~ '^[0-9a-f-]{36}$'
          and ("team_memory_share_grants"."curated_source_update_receipt"->>'previewId') ~ '^[0-9a-f-]{36}$'))
      ), false));