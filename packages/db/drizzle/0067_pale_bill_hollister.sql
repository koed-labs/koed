CREATE TYPE "public"."scheduled_job_run_status" AS ENUM('scheduled', 'running', 'waiting_approval', 'ok', 'failed', 'interrupted', 'missed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."scheduled_job_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'scheduled_job_changed' BEFORE 'access_revoked';--> statement-breakpoint
CREATE TABLE "scheduled_job_attempt_dispatch_bindings" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"managed_execution_id" uuid NOT NULL,
	"managed_execution_generation" integer NOT NULL,
	"managed_command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_attempt_dispatch_command_unique" UNIQUE("managed_command_id"),
	CONSTRAINT "scheduled_job_attempt_dispatch_generation_positive" CHECK ("scheduled_job_attempt_dispatch_bindings"."managed_execution_generation">0)
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"fence_generation" integer NOT NULL,
	"status" "scheduled_job_run_status" NOT NULL,
	"lease_owner_id" text,
	"lease_expires_at" timestamp with time zone,
	"uncertainty" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_attempt_events_kind" CHECK ("scheduled_job_attempt_events"."event_kind" in ('attempt_start','state','lease_acquired','lease_renewed','fence_changed')),
	CONSTRAINT "scheduled_job_attempt_events_fence_positive" CHECK ("scheduled_job_attempt_events"."fence_generation">0),
	CONSTRAINT "scheduled_job_attempt_events_lease_shape" CHECK (("scheduled_job_attempt_events"."lease_owner_id" is null)=("scheduled_job_attempt_events"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"fence_generation" integer NOT NULL,
	"fence_token_hash" text NOT NULL,
	"job_version" integer NOT NULL,
	"runner_device_id" uuid NOT NULL,
	"conversation_session_id" uuid NOT NULL,
	"conversation_project_assignment_version" integer NOT NULL,
	"project_id" uuid,
	"project_version" integer,
	"team_backend_id" text,
	"workspace_project_id" uuid,
	"team_project_version" integer,
	"team_member_version" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_attempts_run_number_unique" UNIQUE("run_id","attempt"),
	CONSTRAINT "scheduled_job_attempts_execution_unique" UNIQUE("execution_id"),
	CONSTRAINT "scheduled_job_attempts_positive" CHECK ("scheduled_job_attempts"."attempt">0 and "scheduled_job_attempts"."fence_generation">0 and "scheduled_job_attempts"."job_version">0),
	CONSTRAINT "scheduled_job_attempts_project_shape" CHECK (("scheduled_job_attempts"."project_id" is null)=("scheduled_job_attempts"."project_version" is null)),
	CONSTRAINT "scheduled_job_attempts_team_shape" CHECK ((
    "scheduled_job_attempts"."team_backend_id" is null and "scheduled_job_attempts"."workspace_project_id" is null
    and "scheduled_job_attempts"."team_project_version" is null and "scheduled_job_attempts"."team_member_version" is null
    ) or (
    "scheduled_job_attempts"."team_backend_id" is not null and "scheduled_job_attempts"."workspace_project_id" is not null
    and "scheduled_job_attempts"."team_project_version">0 and "scheduled_job_attempts"."team_member_version">0
    ))
);
--> statement-breakpoint
CREATE TABLE "scheduled_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"manual_request_id" uuid,
	"scheduled_for" timestamp with time zone NOT NULL,
	"trigger" "scheduled_job_trigger" NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" "scheduled_job_run_status" DEFAULT 'scheduled' NOT NULL,
	"skip_reason" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"execution_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_runs_occurrence_unique" UNIQUE("job_id","scheduled_for"),
	CONSTRAINT "scheduled_job_runs_manual_request_unique" UNIQUE("job_id","manual_request_id"),
	CONSTRAINT "scheduled_job_runs_manual_request_shape" CHECK (("scheduled_job_runs"."trigger"='manual')=("scheduled_job_runs"."manual_request_id" is not null)),
	CONSTRAINT "scheduled_job_runs_attempt_nonnegative" CHECK ("scheduled_job_runs"."attempt">=0),
	CONSTRAINT "scheduled_job_runs_skip_reason_check" CHECK ("scheduled_job_runs"."status"='skipped' or "scheduled_job_runs"."skip_reason" is null)
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creation_request_id" uuid NOT NULL,
	"creation_payload_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid,
	"agent_id" uuid NOT NULL,
	"conversation_session_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"runner_device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "scheduled_jobs_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "scheduled_jobs_owner_request_unique" UNIQUE("owner_user_id","creation_request_id"),
	CONSTRAINT "scheduled_jobs_version_positive" CHECK ("scheduled_jobs"."version">0),
	CONSTRAINT "scheduled_jobs_title_length" CHECK (length(trim("scheduled_jobs"."title")) between 1 and 160),
	CONSTRAINT "scheduled_jobs_instruction_length" CHECK (length(trim("scheduled_jobs"."instruction")) between 1 and 20000),
	CONSTRAINT "scheduled_jobs_schedule_object" CHECK (jsonb_typeof("scheduled_jobs"."schedule")='object')
);
--> statement-breakpoint
ALTER TABLE "scheduled_job_attempt_dispatch_bindings" ADD CONSTRAINT "scheduled_job_attempt_dispatch_bindings_attempt_id_scheduled_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."scheduled_job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_job_attempt_dispatch_bindings" ADD CONSTRAINT "scheduled_job_attempt_dispatch_execution_fk" FOREIGN KEY ("owner_user_id","managed_execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_job_attempt_dispatch_bindings" ADD CONSTRAINT "scheduled_job_attempt_dispatch_command_fk" FOREIGN KEY ("owner_user_id","managed_execution_id","managed_command_id") REFERENCES "public"."managed_conversation_commands"("owner_user_id","execution_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_job_attempt_events" ADD CONSTRAINT "scheduled_job_attempt_events_attempt_id_scheduled_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."scheduled_job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_job_attempts" ADD CONSTRAINT "scheduled_job_attempts_run_id_scheduled_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scheduled_job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_job_runs" ADD CONSTRAINT "scheduled_job_runs_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_id_owner_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_owner_agent_fk" FOREIGN KEY ("owner_user_id","agent_id") REFERENCES "public"."agents"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_owner_conversation_fk" FOREIGN KEY ("owner_user_id","conversation_session_id") REFERENCES "public"."sessions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_job_attempt_events_attempt_idx" ON "scheduled_job_attempt_events" USING btree ("attempt_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_job_runs_one_active_per_job" ON "scheduled_job_runs" USING btree ("job_id") WHERE "scheduled_job_runs"."status" in ('running','waiting_approval');--> statement-breakpoint
CREATE INDEX "scheduled_job_runs_job_time_idx" ON "scheduled_job_runs" USING btree ("job_id","scheduled_for" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scheduled_jobs_owner_updated_idx" ON "scheduled_jobs" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scheduled_jobs_device_active_idx" ON "scheduled_jobs" USING btree ("runner_device_id","paused");--> statement-breakpoint
UPDATE project_lifecycle_schema_capabilities
   SET state='enabled',enabled_at=now()
 WHERE capability='project_scheduled_jobs' AND state='absent';
--> statement-breakpoint
CREATE FUNCTION scheduled_job_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Scheduled Job history is immutable';
  END IF;
  IF TG_TABLE_NAME='scheduled_job_attempt_dispatch_bindings' THEN
    IF EXISTS (SELECT 1 FROM scheduled_job_attempts WHERE id=OLD.attempt_id) THEN
      RAISE EXCEPTION 'Scheduled Job dispatch binding cannot be deleted directly';
    END IF;
  END IF;
  IF TG_TABLE_NAME='scheduled_job_attempt_events' THEN
    IF EXISTS (SELECT 1 FROM scheduled_job_attempts WHERE id=OLD.attempt_id) THEN
      RAISE EXCEPTION 'Scheduled Job event cannot be deleted directly';
    END IF;
  END IF;
  IF TG_TABLE_NAME='scheduled_job_attempts' THEN
    IF EXISTS (SELECT 1 FROM scheduled_job_runs WHERE id=OLD.run_id) THEN
      RAISE EXCEPTION 'Scheduled Job attempt cannot be deleted directly';
    END IF;
  END IF;
  IF TG_TABLE_NAME='scheduled_job_runs' THEN
    IF EXISTS (SELECT 1 FROM scheduled_jobs WHERE id=OLD.job_id) THEN
      RAISE EXCEPTION 'Scheduled Job run cannot be deleted directly';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scheduled_job_attempt_dispatch_bindings_immutable
  BEFORE UPDATE OR DELETE ON scheduled_job_attempt_dispatch_bindings
  FOR EACH ROW EXECUTE FUNCTION scheduled_job_history_immutable();
--> statement-breakpoint
CREATE TRIGGER scheduled_job_attempt_events_immutable
  BEFORE UPDATE OR DELETE ON scheduled_job_attempt_events
  FOR EACH ROW EXECUTE FUNCTION scheduled_job_history_immutable();
--> statement-breakpoint
CREATE TRIGGER scheduled_job_attempts_immutable
  BEFORE UPDATE OR DELETE ON scheduled_job_attempts
  FOR EACH ROW EXECUTE FUNCTION scheduled_job_history_immutable();
--> statement-breakpoint
CREATE TRIGGER scheduled_job_runs_delete_guard
  BEFORE DELETE ON scheduled_job_runs
  FOR EACH ROW EXECUTE FUNCTION scheduled_job_history_immutable();
