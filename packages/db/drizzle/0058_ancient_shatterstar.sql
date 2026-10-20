CREATE TABLE "team_memory_curated_withdrawal_fences" (
	"share_grant_id" uuid NOT NULL,
	"pseudonymous_source_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"classification_version" integer NOT NULL,
	"mutation_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_curated_withdrawal_fences_share_grant_id_pseudonymous_source_id_pk" PRIMARY KEY("share_grant_id","pseudonymous_source_id"),
	CONSTRAINT "team_memory_curated_withdrawal_fences_shape_check" CHECK ("team_memory_curated_withdrawal_fences"."classification_version" > 0 and length("team_memory_curated_withdrawal_fences"."manifest_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "classification_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_curated_withdrawal_fences" ADD CONSTRAINT "team_memory_curated_withdrawal_fences_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_classification_version_check" CHECK ("curated_memory_assertions"."classification_version" > 0);