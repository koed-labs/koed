CREATE TABLE "home_reminder_states" (
  "owner_user_id" uuid NOT NULL,
  "source_event_id" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "source_revision" text NOT NULL,
  "cleared" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "home_reminder_states_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "home_reminder_states_owner_user_id_source_event_id_pk" PRIMARY KEY ("owner_user_id", "source_event_id"),
  CONSTRAINT "home_reminder_source_kind_check" CHECK ("source_kind" in ('managed_runtime_item', 'managed_execution', 'personal_agent_job', 'pull_request_review')),
  CONSTRAINT "home_reminder_source_event_id_check" CHECK ("source_event_id" ~ '^[A-Za-z0-9._:-]+$')
);
