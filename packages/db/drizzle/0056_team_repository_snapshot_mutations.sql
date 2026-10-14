CREATE TABLE "team_repository_snapshot_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result_grant_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_repository_snapshot_mutations" ADD CONSTRAINT "team_repository_snapshot_mutations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_repository_snapshot_mutations" ADD CONSTRAINT "team_repository_snapshot_mutations_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;