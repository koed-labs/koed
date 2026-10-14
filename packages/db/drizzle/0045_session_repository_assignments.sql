CREATE TABLE "session_repository_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"observation_hash" text NOT NULL,
	"identity" jsonb NOT NULL,
	"captured_cwd" text,
	"is_conflict" boolean NOT NULL,
	"assignment_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_assignment_state" text DEFAULT 'historical_unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_assignment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_automatic_identity" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_override_identity" jsonb;--> statement-breakpoint
ALTER TABLE "session_repository_observations" ADD CONSTRAINT "session_repository_observations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repository_observations" ADD CONSTRAINT "session_repository_observations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_repository_observations_dedupe_idx" ON "session_repository_observations" USING btree ("session_id","observation_hash");--> statement-breakpoint
CREATE INDEX "session_repository_observations_owner_idx" ON "session_repository_observations" USING btree ("owner_user_id","session_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_repository_identity_idx" ON "sessions" USING btree ("owner_user_id",(coalesce("repository_override_identity", "repository_automatic_identity") ->> 'key'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repository_assignment_shape_check" CHECK ("sessions"."repository_assignment_state" in ('recorded', 'historical_unresolved') and "sessions"."repository_assignment_version" > 0 and ("sessions"."repository_assignment_state" <> 'historical_unresolved' or "sessions"."repository_automatic_identity" is null));