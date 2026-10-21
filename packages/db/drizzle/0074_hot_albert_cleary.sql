CREATE TABLE "deck_card_progress" (
	"owner_user_id" uuid NOT NULL,
	"personal_project_id" uuid NOT NULL,
	"team_backend_id" text,
	"workspace_project_id" uuid,
	"deck_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"box" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone,
	"misses" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deck_card_progress_owner_user_id_personal_project_id_card_id_pk" PRIMARY KEY("owner_user_id","personal_project_id","card_id"),
	CONSTRAINT "deck_card_progress_box_nonnegative" CHECK ("deck_card_progress"."box" >= 0),
	CONSTRAINT "deck_card_progress_misses_nonnegative" CHECK ("deck_card_progress"."misses" >= 0),
	CONSTRAINT "deck_card_progress_team_pair" CHECK (("deck_card_progress"."team_backend_id" is null and "deck_card_progress"."workspace_project_id" is null) or ("deck_card_progress"."team_backend_id" is not null and "deck_card_progress"."workspace_project_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "deck_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"deck_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_ref" text,
	"topic_label" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deck_cards_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "deck_cards_question_nonblank" CHECK (length(trim("deck_cards"."question")) > 0),
	CONSTRAINT "deck_cards_answer_nonblank" CHECK (length(trim("deck_cards"."answer")) > 0),
	CONSTRAINT "deck_cards_version_positive" CHECK ("deck_cards"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"made_from" text NOT NULL,
	"created_by_agent_id" uuid,
	"idempotency_key" text,
	"creation_payload_hash" text,
	"uses" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_decks_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "project_decks_create_unique" UNIQUE("owner_user_id","project_id","idempotency_key"),
	CONSTRAINT "project_decks_title_nonblank" CHECK (length(trim("project_decks"."title")) > 0),
	CONSTRAINT "project_decks_uses_nonnegative" CHECK ("project_decks"."uses" >= 0),
	CONSTRAINT "project_decks_version_positive" CHECK ("project_decks"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_project_deck_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"deck_id" uuid NOT NULL,
	"source_card_id" uuid,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_ref" text,
	"topic_label" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_deck_cards_deck_id_unique" UNIQUE("deck_id","id"),
	CONSTRAINT "workspace_project_deck_cards_source_unique" UNIQUE("deck_id","source_card_id"),
	CONSTRAINT "workspace_project_deck_cards_version_positive" CHECK ("workspace_project_deck_cards"."version" > 0),
	CONSTRAINT "workspace_project_deck_cards_question_nonblank" CHECK (length(trim("workspace_project_deck_cards"."question")) > 0),
	CONSTRAINT "workspace_project_deck_cards_answer_nonblank" CHECK (length(trim("workspace_project_deck_cards"."answer")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_project_decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"created_by_team_member_id" uuid NOT NULL,
	"source_deck_id" uuid,
	"idempotency_key" text,
	"creation_payload_hash" text,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"made_from" text NOT NULL,
	"created_by_agent_id" uuid,
	"uses" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_decks_project_id_unique" UNIQUE("workspace_project_id","id"),
	CONSTRAINT "workspace_project_decks_source_unique" UNIQUE("workspace_project_id","created_by_team_member_id","source_deck_id"),
	CONSTRAINT "workspace_project_decks_create_unique" UNIQUE("workspace_project_id","created_by_team_member_id","idempotency_key"),
	CONSTRAINT "workspace_project_decks_version_positive" CHECK ("workspace_project_decks"."version" > 0),
	CONSTRAINT "workspace_project_decks_uses_nonnegative" CHECK ("workspace_project_decks"."uses" >= 0),
	CONSTRAINT "workspace_project_decks_title_nonblank" CHECK (length(trim("workspace_project_decks"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" ADD COLUMN "decks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deck_card_progress" ADD CONSTRAINT "deck_card_progress_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_card_progress" ADD CONSTRAINT "deck_card_progress_owner_project_fk" FOREIGN KEY ("owner_user_id","personal_project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_cards" ADD CONSTRAINT "deck_cards_owner_deck_fk" FOREIGN KEY ("owner_user_id","deck_id") REFERENCES "public"."project_decks"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decks" ADD CONSTRAINT "project_decks_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decks" ADD CONSTRAINT "project_decks_owner_agent_fk" FOREIGN KEY ("created_by_agent_id","owner_user_id") REFERENCES "public"."agents"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_deck_cards" ADD CONSTRAINT "workspace_project_deck_cards_deck_fk" FOREIGN KEY ("workspace_project_id","deck_id") REFERENCES "public"."workspace_project_decks"("workspace_project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_decks" ADD CONSTRAINT "workspace_project_decks_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_decks" ADD CONSTRAINT "workspace_project_decks_created_by_team_member_id_team_memberships_id_fk" FOREIGN KEY ("created_by_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deck_card_progress_due_idx" ON "deck_card_progress" USING btree ("owner_user_id","personal_project_id","next_at");--> statement-breakpoint
CREATE INDEX "project_decks_page_idx" ON "project_decks" USING btree ("owner_user_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "workspace_project_decks_page_idx" ON "workspace_project_decks" USING btree ("workspace_project_id","created_at","id");--> statement-breakpoint
-- The Project child lifecycle adapter is active in the same migration as the Deck tables.
UPDATE project_lifecycle_schema_capabilities SET state='enabled',enabled_at=now()
WHERE capability='project_decks' AND state='absent';
