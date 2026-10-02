CREATE TABLE "team_overview_reminder_states" (
	"owner_user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"source_event_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" text NOT NULL,
	"cleared" boolean DEFAULT false NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_overview_reminder_states_owner_user_id_team_id_source_event_id_pk" PRIMARY KEY("owner_user_id","team_id","source_event_id"),
	CONSTRAINT "team_overview_source_kind_check" CHECK ("team_overview_reminder_states"."source_kind" in ('message_attention', 'agent_request', 'team_job_action', 'team_job_outcome', 'pull_request_action')),
	CONSTRAINT "team_overview_source_event_id_check" CHECK ("team_overview_reminder_states"."source_event_id" ~ '^[A-Za-z0-9._:-]+$')
);
--> statement-breakpoint
ALTER TABLE "team_overview_reminder_states" ADD CONSTRAINT "team_overview_reminder_states_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_overview_reminder_states" ADD CONSTRAINT "team_overview_reminder_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_overview_reminder_states_team_updated_idx" ON "team_overview_reminder_states" USING btree ("team_id","owner_user_id","updated_at" DESC NULLS LAST);