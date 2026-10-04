CREATE TABLE "conversation_source_rebase_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"parent_artifact_id" uuid NOT NULL,
	"successor_artifact_id" uuid NOT NULL,
	"parent_closure_hash" text NOT NULL,
	"expected_parent_frontier" jsonb NOT NULL,
	"accepted_frontier" jsonb NOT NULL,
	"command_proof" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_source_rebase_proofs_parent_unique" UNIQUE("parent_artifact_id"),
	CONSTRAINT "conversation_source_rebase_proofs_successor_unique" UNIQUE("successor_artifact_id"),
	CONSTRAINT "conversation_source_rebase_proofs_hash_check" CHECK ("conversation_source_rebase_proofs"."parent_closure_hash" ~ '^[0-9a-f]{64}$'
        and jsonb_typeof("conversation_source_rebase_proofs"."expected_parent_frontier") = 'object'
        and jsonb_typeof("conversation_source_rebase_proofs"."accepted_frontier") = 'object'
        and jsonb_typeof("conversation_source_rebase_proofs"."command_proof") = 'object')
);
--> statement-breakpoint
ALTER TABLE "conversation_source_rebase_proofs" ADD CONSTRAINT "conversation_source_rebase_proofs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_source_rebase_proofs" ADD CONSTRAINT "conversation_source_rebase_proofs_parent_owner_fk" FOREIGN KEY ("parent_artifact_id","owner_user_id") REFERENCES "public"."conversation_source_artifacts"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_source_rebase_proofs" ADD CONSTRAINT "conversation_source_rebase_proofs_successor_owner_fk" FOREIGN KEY ("successor_artifact_id","owner_user_id") REFERENCES "public"."conversation_source_artifacts"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_source_rebase_proofs_owner_created_idx" ON "conversation_source_rebase_proofs" USING btree ("owner_user_id","created_at" DESC NULLS LAST);
