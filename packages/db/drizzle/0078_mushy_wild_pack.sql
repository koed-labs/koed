CREATE TABLE "personal_agent_chat_generic_participants" (
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"participant_key" text NOT NULL,
	"provider" text NOT NULL,
	"ai_client_instance_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"launch_snapshot" jsonb NOT NULL,
	"execution_id" uuid,
	"last_context_cursor" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_generic_participants_pk" PRIMARY KEY("conversation_id","participant_key"),
	CONSTRAINT "personal_agent_chat_generic_participants_ordinal_unique" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "personal_agent_chat_generic_participants_key_check" CHECK ("personal_agent_chat_generic_participants"."participant_key" ~ '^[0-9a-f]{64}$' and "personal_agent_chat_generic_participants"."ordinal" >= 0
        and "personal_agent_chat_generic_participants"."last_context_cursor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "personal_agent_chat_deliveries" ADD COLUMN "cancel_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_roots" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "personal_agent_chat_roots"
   SET "workspace_id" = coalesce(
     (
       select coalesce(execution."personal_agent_chat_workspace_id", execution."id")
         from "managed_conversation_executions" execution
        where execution."owner_user_id" = "personal_agent_chat_roots"."owner_user_id"
          and execution."id" = nullif("personal_agent_chat_roots"."source_execution_ids" ->> 0, '')::uuid
     ),
     "conversation_id"
   )
 WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_roots" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_generic_participants" ADD CONSTRAINT "personal_agent_chat_generic_participants_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;
