CREATE TABLE "managed_agent_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_execution_id" uuid,
	"parent_execution_generation" integer,
	"cold_hq_project_id" uuid,
	"child_execution_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_label" text NOT NULL,
	"request_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_agent_delegations_owner_request_unique" UNIQUE("owner_user_id","request_id"),
	CONSTRAINT "managed_agent_delegations_child_unique" UNIQUE("child_execution_id"),
	CONSTRAINT "managed_agent_delegations_identity_check" CHECK ((("managed_agent_delegations"."parent_execution_id" is null and "managed_agent_delegations"."parent_execution_generation" is null
          and "managed_agent_delegations"."cold_hq_project_id" is not null
          and "managed_agent_delegations"."cold_hq_project_id" = "managed_agent_delegations"."project_id")
        or ("managed_agent_delegations"."parent_execution_id" is not null
          and "managed_agent_delegations"."parent_execution_generation" is not null
          and "managed_agent_delegations"."parent_execution_generation" > 0
          and "managed_agent_delegations"."parent_execution_id" <> "managed_agent_delegations"."child_execution_id"
          and "managed_agent_delegations"."cold_hq_project_id" is null))
        and length("managed_agent_delegations"."request_id") between 8 and 255
        and length(trim("managed_agent_delegations"."task_label")) between 1 and 200
        and "managed_agent_delegations"."request_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "managed_agent_delegations" ADD CONSTRAINT "managed_agent_delegations_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_hq_conversations" ADD CONSTRAINT "project_hq_conversations_owner_project_unique" UNIQUE("owner_user_id","project_id");--> statement-breakpoint
ALTER TABLE "managed_agent_delegations" ADD CONSTRAINT "managed_agent_delegations_owner_hq_fk" FOREIGN KEY ("owner_user_id","cold_hq_project_id") REFERENCES "public"."project_hq_conversations"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_agent_delegations" ADD CONSTRAINT "managed_agent_delegations_parent_fk" FOREIGN KEY ("owner_user_id","parent_execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_agent_delegations" ADD CONSTRAINT "managed_agent_delegations_child_fk" FOREIGN KEY ("owner_user_id","child_execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_agent_delegations" ADD CONSTRAINT "managed_agent_delegations_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."agents"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_agent_delegations_parent_idx" ON "managed_agent_delegations" USING btree ("owner_user_id","parent_execution_id");--> statement-breakpoint
