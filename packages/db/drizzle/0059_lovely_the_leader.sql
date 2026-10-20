CREATE TABLE "curated_memory_classification_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"expected_version" integer NOT NULL,
	"next_version" integer NOT NULL,
	"target_scope" "curated_memory_scope" NOT NULL,
	"target_project_id" uuid,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"backend_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curated_classification_assertion_version_unique" UNIQUE("assertion_id","next_version"),
	CONSTRAINT "curated_classification_versions_check" CHECK ("curated_memory_classification_operations"."expected_version">0 and "curated_memory_classification_operations"."next_version"="curated_memory_classification_operations"."expected_version"+1),
	CONSTRAINT "curated_classification_target_check" CHECK (("curated_memory_classification_operations"."target_scope"='project')=("curated_memory_classification_operations"."target_project_id" is not null)),
	CONSTRAINT "curated_classification_state_check" CHECK ("curated_memory_classification_operations"."state" in ('pending','ready','complete','conflict')),
	CONSTRAINT "curated_classification_manifest_check" CHECK (length("curated_memory_classification_operations"."manifest_hash")=64 and jsonb_typeof("curated_memory_classification_operations"."manifest")='array'
        and jsonb_typeof("curated_memory_classification_operations"."backend_acks")='array')
);
--> statement-breakpoint
CREATE TABLE "team_memory_curated_assertion_fences" (
	"logical_memory_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"classification_version" integer NOT NULL,
	"mutation_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_curated_assertion_fences_logical_memory_id_assertion_id_pk" PRIMARY KEY("logical_memory_id","assertion_id"),
	CONSTRAINT "team_curated_assertion_fence_shape_check" CHECK ("team_memory_curated_assertion_fences"."classification_version">0 and length("team_memory_curated_assertion_fences"."manifest_hash")=64)
);
--> statement-breakpoint
CREATE TABLE "team_memory_curated_withdrawal_receipts" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"assertion_id" uuid NOT NULL,
	"source_logical_memory_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"source_deployment_protocol_id" uuid NOT NULL,
	"classification_version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_curated_withdrawal_receipt_shape_check" CHECK ("team_memory_curated_withdrawal_receipts"."classification_version">0 and "team_memory_curated_withdrawal_receipts"."item_count">=0
        and length("team_memory_curated_withdrawal_receipts"."manifest_hash")=64)
);
--> statement-breakpoint
-- Existing assertions remain in the durable withdrawal queue. New assertions
-- begin active only after this backfill boundary has been installed.
ALTER TABLE "curated_memory_assertions" ADD COLUMN "scope_activation_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ALTER COLUMN "scope_activation_state" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_owner_id_unique" UNIQUE("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "curated_memory_classification_operations" ADD CONSTRAINT "curated_classification_assertion_fk" FOREIGN KEY ("owner_user_id","assertion_id") REFERENCES "public"."curated_memory_assertions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_classification_operations" ADD CONSTRAINT "curated_classification_project_fk" FOREIGN KEY ("owner_user_id","target_project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "curated_classification_pending_idx" ON "curated_memory_classification_operations" USING btree ("state","updated_at");--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_scope_activation_check" CHECK ("curated_memory_assertions"."scope_activation_state" in ('pending','active'));
--> statement-breakpoint
ALTER TYPE "public"."curated_memory_source_type" ADD VALUE 'project_source_note_revision';
--> statement-breakpoint
ALTER TYPE "public"."curated_memory_source_type" ADD VALUE 'project_work_item';
