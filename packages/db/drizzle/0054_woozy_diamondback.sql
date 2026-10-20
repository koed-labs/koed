CREATE TABLE "project_source_turn_uses" (
	"owner_user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"captured_session_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"provenance" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_turn_uses_owner_user_id_source_id_captured_session_id_turn_id_pk" PRIMARY KEY("owner_user_id","source_id","captured_session_id","turn_id"),
	CONSTRAINT "project_source_turn_uses_provenance_check" CHECK ("project_source_turn_uses"."provenance" in ('citation','tool_read')),
	CONSTRAINT "project_source_turn_uses_turn_check" CHECK (length(trim("project_source_turn_uses"."turn_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"uri" text,
	"current_revision_id" uuid,
	"status" text NOT NULL,
	"failure_reason" text,
	"added_by" uuid NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_sources_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "project_sources_kind_check" CHECK ("project_sources"."kind" in ('doc','folder','repo','skill')),
	CONSTRAINT "project_sources_status_check" CHECK ("project_sources"."status" in ('uploading','extracting','ready','failed')),
	CONSTRAINT "project_sources_failure_check" CHECK (("project_sources"."status" = 'failed' and "project_sources"."failure_reason" is not null) or ("project_sources"."status" <> 'failed' and "project_sources"."failure_reason" is null)),
	CONSTRAINT "project_sources_uses_check" CHECK ("project_sources"."uses" >= 0),
	CONSTRAINT "project_sources_name_check" CHECK (length(trim("project_sources"."name")) > 0),
	CONSTRAINT "project_sources_trash_batch_check" CHECK ("project_sources"."delete_batch_id" is null or "project_sources"."deleted_at" is not null),
	CONSTRAINT "project_sources_document_revision_check" CHECK ("project_sources"."current_revision_id" is null or "project_sources"."kind" = 'doc')
);
--> statement-breakpoint
ALTER TABLE "project_source_turn_uses" ADD CONSTRAINT "project_source_turn_uses_owner_source_fk" FOREIGN KEY ("owner_user_id","source_id") REFERENCES "public"."project_sources"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_owner_note_revision_fk" FOREIGN KEY ("current_revision_id","owner_user_id") REFERENCES "public"."personal_note_revisions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_added_by_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sources_active_idx" ON "project_sources" USING btree ("owner_user_id","project_id","deleted_at","created_at");--> statement-breakpoint
UPDATE project_lifecycle_schema_capabilities
   SET state='enabled', enabled_at=now()
 WHERE capability='project_sources' AND state='absent';
