CREATE TABLE "project_hq_conversations" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"managed_execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_hq_conversations_execution_unique" UNIQUE("managed_execution_id")
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "is_project_hq" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "hq_private_path" text;--> statement-breakpoint
ALTER TABLE "project_hq_conversations" ADD CONSTRAINT "project_hq_conversations_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_owner_id_unique" UNIQUE("owner_user_id","id");--> statement-breakpoint
ALTER TABLE "project_hq_conversations" ADD CONSTRAINT "project_hq_conversations_owner_execution_fk" FOREIGN KEY ("owner_user_id","managed_execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_hq_path_check" CHECK (("managed_conversation_executions"."is_project_hq" and "managed_conversation_executions"."hq_private_path" is not null)
        or (not "managed_conversation_executions"."is_project_hq" and "managed_conversation_executions"."hq_private_path" is null));