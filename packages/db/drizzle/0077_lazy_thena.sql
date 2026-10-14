CREATE TABLE "personal_agent_chat_control_requests" (
	"owner_user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"request_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_control_requests_pk" PRIMARY KEY("owner_user_id","request_id"),
	CONSTRAINT "personal_agent_chat_control_requests_operation_check" CHECK ("personal_agent_chat_control_requests"."operation" in ('cancel', 'continue')),
	CONSTRAINT "personal_agent_chat_control_requests_digest_check" CHECK ("personal_agent_chat_control_requests"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD COLUMN "personal_agent_chat_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "personal_agent_chat_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_control_requests" ADD CONSTRAINT "personal_agent_chat_control_requests_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;