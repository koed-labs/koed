CREATE TABLE "personal_note_projection_cursors" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"last_thread_sequence" bigint DEFAULT 0 NOT NULL,
	"scanned_count" bigint DEFAULT 0 NOT NULL,
	"existing_count" bigint DEFAULT 0 NOT NULL,
	"created_count" bigint DEFAULT 0 NOT NULL,
	"embedding_queued_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"last_failure_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_note_projection_cursors_thread_unique" UNIQUE("thread_id"),
	CONSTRAINT "personal_note_projection_cursors_counts_check" CHECK ("personal_note_projection_cursors"."last_thread_sequence" >= 0
        and "personal_note_projection_cursors"."scanned_count" >= 0
        and "personal_note_projection_cursors"."existing_count" >= 0
        and "personal_note_projection_cursors"."created_count" >= 0
        and "personal_note_projection_cursors"."embedding_queued_count" >= 0
        and "personal_note_projection_cursors"."failure_count" >= 0
        and "personal_note_projection_cursors"."existing_count" + "personal_note_projection_cursors"."created_count" + "personal_note_projection_cursors"."failure_count" = "personal_note_projection_cursors"."scanned_count")
);
--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_thread_fk" FOREIGN KEY ("thread_id","owner_user_id") REFERENCES "public"."collaboration_threads"("id","personal_owner_user_id") ON DELETE restrict ON UPDATE no action;