CREATE TABLE "chat_delete_operations" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"execution_manifest" jsonb NOT NULL,
	"execution_set_hash" text NOT NULL,
	"backend_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_freeze_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runtime_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_delete_operations_state_check" CHECK ("chat_delete_operations"."state" in ('preparing','freezing','stopping','ready','complete','cancelled','needs_attention','restore_releasing','restored')),
	CONSTRAINT "chat_delete_operations_manifest_hash_check" CHECK (length("chat_delete_operations"."source_manifest_hash")=64 and length("chat_delete_operations"."execution_set_hash")=64)
);
--> statement-breakpoint
CREATE TABLE "chat_forget_operations" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"state" text DEFAULT 'stopping' NOT NULL,
	"execution_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runtime_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forgotten_at" timestamp with time zone,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assertion_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_forget_operations_state_check" CHECK ("chat_forget_operations"."state" in ('stopping','complete','undone')),
	CONSTRAINT "chat_forget_operations_snapshot_arrays_check" CHECK (jsonb_typeof("chat_forget_operations"."event_ids")='array' and jsonb_typeof("chat_forget_operations"."item_ids")='array' and jsonb_typeof("chat_forget_operations"."node_ids")='array' and jsonb_typeof("chat_forget_operations"."assertion_snapshots")='array')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "forget_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_delete_operations" ADD CONSTRAINT "chat_delete_operations_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_forget_operations" ADD CONSTRAINT "chat_forget_operations_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_delete_operations_owner_idx" ON "chat_delete_operations" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_forget_operations_owner_idx" ON "chat_forget_operations" USING btree ("owner_user_id","created_at" DESC NULLS LAST);