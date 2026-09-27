CREATE TABLE "managed_conversation_project_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"source_project_id" text,
	"destination_project_id" text NOT NULL,
	"assigned_deployment_id" uuid NOT NULL,
	"assigned_device_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"claimed_by_runner_id" text,
	"claim_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "managed_conversation_project_moves_owner_execution_id_unique" UNIQUE("id","owner_user_id","execution_id"),
	CONSTRAINT "managed_conversation_project_moves_idempotency_unique" UNIQUE("owner_user_id","execution_id","idempotency_key"),
	CONSTRAINT "managed_conversation_project_moves_shape_check" CHECK ("managed_conversation_project_moves"."execution_generation" > 0
        and length(trim("managed_conversation_project_moves"."idempotency_key")) between 16 and 160
        and "managed_conversation_project_moves"."request_digest" ~ '^[0-9a-f]{64}$'
        and length(trim("managed_conversation_project_moves"."destination_project_id")) between 1 and 512
        and "managed_conversation_project_moves"."state" in ('pending', 'claimed', 'cancelled', 'completed', 'failed')
        and "managed_conversation_project_moves"."claim_attempts" >= 0
        and (("managed_conversation_project_moves"."claim_token" is null and "managed_conversation_project_moves"."claim_expires_at" is null and "managed_conversation_project_moves"."claimed_by_runner_id" is null)
          or ("managed_conversation_project_moves"."claim_token" is not null and "managed_conversation_project_moves"."claim_expires_at" is not null and length(trim("managed_conversation_project_moves"."claimed_by_runner_id")) > 0))
        and (("managed_conversation_project_moves"."state" = 'pending' and "managed_conversation_project_moves"."claim_token" is null and "managed_conversation_project_moves"."finished_at" is null)
          or ("managed_conversation_project_moves"."state" = 'claimed' and "managed_conversation_project_moves"."claim_token" is not null and "managed_conversation_project_moves"."finished_at" is null)
          or ("managed_conversation_project_moves"."state" in ('cancelled', 'completed', 'failed') and "managed_conversation_project_moves"."claim_token" is null and "managed_conversation_project_moves"."finished_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_project_moves" ADD CONSTRAINT "managed_conversation_project_moves_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_project_moves" ADD CONSTRAINT "managed_conversation_project_moves_owner_execution_fk" FOREIGN KEY ("execution_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_conversation_project_moves_owner_state_idx" ON "managed_conversation_project_moves" USING btree ("owner_user_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "managed_conversation_project_moves_one_active_per_execution" ON "managed_conversation_project_moves" USING btree ("execution_id") WHERE "managed_conversation_project_moves"."state" in ('pending', 'claimed');--> statement-breakpoint
