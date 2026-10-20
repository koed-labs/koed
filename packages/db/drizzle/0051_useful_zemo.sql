CREATE TABLE "project_activity" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_activity_owner_user_id_project_id_sequence_pk" PRIMARY KEY("owner_user_id","project_id","sequence"),
	CONSTRAINT "project_activity_event_unique" UNIQUE("owner_user_id","project_id","kind","ref"),
	CONSTRAINT "project_activity_sequence_positive" CHECK ("project_activity"."sequence" > 0),
	CONSTRAINT "project_activity_ref_nonblank" CHECK (length(trim("project_activity"."ref")) > 0),
	CONSTRAINT "project_activity_kind_check" CHECK ("project_activity"."kind" in ('work_item_created','work_item_status','work_item_done','source_added','source_ready','source_failed','pr_opened','pr_merged','assertion_created'))
);
--> statement-breakpoint
CREATE TABLE "project_seen" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"seen_sequence" bigint DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_seen_owner_user_id_project_id_pk" PRIMARY KEY("owner_user_id","project_id"),
	CONSTRAINT "project_seen_sequence_nonnegative" CHECK ("project_seen"."seen_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_seen" ADD CONSTRAINT "project_seen_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_activity_recent_idx" ON "project_activity" USING btree ("owner_user_id","project_id","at");
