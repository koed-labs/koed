ALTER TABLE "curated_memory_proposals" ADD COLUMN "scope_hint" "curated_memory_scope";--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD COLUMN "kind_hint" "curated_memory_kind";--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD COLUMN "project_context_id" uuid;--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD CONSTRAINT "curated_memory_proposals_owner_project_context_fk" FOREIGN KEY ("owner_user_id","project_context_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;