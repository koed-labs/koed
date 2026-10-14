CREATE TABLE "repository_assignment_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_revision" integer NOT NULL,
	"options" jsonb NOT NULL,
	"sessions" jsonb NOT NULL,
	"status" text DEFAULT 'reviewed' NOT NULL,
	"selected_session_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"originating_device_id" text NOT NULL,
	"checkout_id" text NOT NULL,
	"revision" integer NOT NULL,
	"originating_revision" integer,
	"kind" text NOT NULL,
	"previous_identity" jsonb,
	"target_identity" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "repository_assignment_reviews" ADD CONSTRAINT "repository_assignment_reviews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_assignment_reviews" ADD CONSTRAINT "repository_assignment_reviews_event_id_repository_change_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."repository_change_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_change_events" ADD CONSTRAINT "repository_change_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_review_owner_event_idx" ON "repository_assignment_reviews" USING btree ("owner_user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_change_revision_idx" ON "repository_change_events" USING btree ("owner_user_id","originating_device_id","checkout_id","revision");--> statement-breakpoint
CREATE INDEX "repository_change_owner_status_idx" ON "repository_change_events" USING btree ("owner_user_id","status");