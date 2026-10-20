CREATE TABLE "managed_conversation_turn_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"source_generation_id" uuid,
	"provider_turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"question_backend_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"alias" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"visibility" text NOT NULL,
	"source_owner_namespace" text NOT NULL,
	"source_owner_principal" text NOT NULL,
	"encrypted_detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_conversation_turn_citations_alias_unique" UNIQUE("owner_user_id","logical_session_id","provider_turn_id","alias"),
	CONSTRAINT "managed_conversation_turn_citations_source_unique" UNIQUE("owner_user_id","execution_id","execution_generation","provider_turn_id","tool_call_id","ordinal"),
	CONSTRAINT "managed_conversation_turn_citations_shape_check" CHECK ("managed_conversation_turn_citations"."execution_generation" > 0 and "managed_conversation_turn_citations"."ordinal" >= 0 and length("managed_conversation_turn_citations"."alias") between 1 and 128 and length("managed_conversation_turn_citations"."tool_call_id") between 1 and 512 and length("managed_conversation_turn_citations"."provider_turn_id") between 1 and 512 and "managed_conversation_turn_citations"."source_type" in ('curated_memory','memory_node','memory_event','message') and "managed_conversation_turn_citations"."visibility" in ('personal','team'))
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_turn_citations" ADD CONSTRAINT "managed_conversation_turn_citations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_turn_citations" ADD CONSTRAINT "managed_turn_citations_owner_execution_fk" FOREIGN KEY ("owner_user_id","execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_turn_citations" ADD CONSTRAINT "managed_turn_citations_owner_session_fk" FOREIGN KEY ("owner_user_id","logical_session_id") REFERENCES "public"."sessions"("owner_user_id","logical_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_conversation_turn_citations_turn_idx" ON "managed_conversation_turn_citations" USING btree ("owner_user_id","logical_session_id","provider_turn_id");
