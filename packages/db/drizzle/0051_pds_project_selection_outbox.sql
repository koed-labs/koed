CREATE TABLE "pds_project_selection_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_row_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"transport_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_selection_outbox_revision_row_id_unique" UNIQUE("revision_row_id"),
	CONSTRAINT "pds_project_selection_outbox_state_check" CHECK ("pds_project_selection_outbox"."state" in ('pending','committed','acked') and "pds_project_selection_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pds_project_selection_outbox" ADD CONSTRAINT "pds_project_selection_outbox_revision_row_id_pds_project_selection_revisions_id_fk" FOREIGN KEY ("revision_row_id") REFERENCES "public"."pds_project_selection_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_project_selection_outbox_due_idx" ON "pds_project_selection_outbox" USING btree ("state","retry_at");