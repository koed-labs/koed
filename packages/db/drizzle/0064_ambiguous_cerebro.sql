CREATE TABLE "source_control_merge_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"pr_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"readiness_digest" text NOT NULL,
	"prepared" jsonb NOT NULL,
	"state" text NOT NULL,
	"provider_operation_id" uuid,
	"merge_commit_object_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_control_merge_state_check" CHECK ("source_control_merge_operations"."state" in ('prepared', 'claimed', 'pending', 'merged', 'rejected', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "source_control_merge_operations" ADD CONSTRAINT "source_control_merge_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_control_merge_owner_idempotency_unique" ON "source_control_merge_operations" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "source_control_merge_active_pr_unique" ON "source_control_merge_operations" USING btree ("owner_user_id","pr_key") WHERE "source_control_merge_operations"."state" in ('claimed', 'pending', 'unknown');