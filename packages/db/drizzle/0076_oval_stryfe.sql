CREATE TABLE "personal_agent_chat_source_claims" (
	"owner_user_id" uuid NOT NULL,
	"source_execution_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_source_claims_pk" PRIMARY KEY("owner_user_id","source_execution_id"),
	CONSTRAINT "personal_agent_chat_source_claims_source_root_unique" UNIQUE("source_execution_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "personal_agent_chat_messages" ADD COLUMN "source_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_messages" ADD COLUMN "source_command_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_source_claims" ADD CONSTRAINT "personal_agent_chat_source_claims_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_source_claims" ADD CONSTRAINT "personal_agent_chat_source_claims_execution_fk" FOREIGN KEY ("source_execution_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;