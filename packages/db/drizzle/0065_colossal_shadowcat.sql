CREATE TABLE "managed_conversation_memory_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"provider_turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"encrypted_request" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"encrypted_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "managed_memory_actions_tool_call_unique" UNIQUE("owner_user_id","execution_id","command_id","provider_turn_id","tool_call_id"),
	CONSTRAINT "managed_memory_actions_shape_check" CHECK ("managed_conversation_memory_actions"."execution_generation" > 0
        and length("managed_conversation_memory_actions"."provider_turn_id") between 1 and 512
        and length("managed_conversation_memory_actions"."tool_call_id") between 1 and 512
        and "managed_conversation_memory_actions"."action_kind" in ('forget','correct')
        and "managed_conversation_memory_actions"."state" in ('pending','completed','rejected')
        and "managed_conversation_memory_actions"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_owner_id_unique" UNIQUE("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_owner_execution_id_unique" UNIQUE("owner_user_id","execution_id","id");--> statement-breakpoint
ALTER TABLE "managed_conversation_memory_actions" ADD CONSTRAINT "managed_memory_actions_owner_execution_fk" FOREIGN KEY ("owner_user_id","execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_memory_actions" ADD CONSTRAINT "managed_memory_actions_owner_command_fk" FOREIGN KEY ("owner_user_id","execution_id","command_id") REFERENCES "public"."managed_conversation_commands"("owner_user_id","execution_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_memory_actions" ADD CONSTRAINT "managed_memory_actions_owner_session_fk" FOREIGN KEY ("owner_user_id","logical_session_id") REFERENCES "public"."sessions"("owner_user_id","logical_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_memory_actions_command_state_idx" ON "managed_conversation_memory_actions" USING btree ("owner_user_id","command_id","state");--> statement-breakpoint
