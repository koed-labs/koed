ALTER TABLE "personal_agent_execution_attempts" ADD COLUMN "phase" text DEFAULT 'working' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD COLUMN "phase_observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD COLUMN "provider_turn_id" text;--> statement-breakpoint
UPDATE "personal_agent_execution_attempts" SET "phase_observed_at" = "started_at";--> statement-breakpoint
ALTER TABLE "personal_agent_team_job_publications" ADD COLUMN "frozen_phase" text;--> statement-breakpoint
ALTER TABLE "personal_agent_team_job_publications" ADD COLUMN "frozen_phase_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD CONSTRAINT "personal_agent_execution_attempts_phase_check" CHECK ("personal_agent_execution_attempts"."phase" in ('working', 'checking') and ("personal_agent_execution_attempts"."provider_turn_id" is null or length(trim("personal_agent_execution_attempts"."provider_turn_id")) between 1 and 512));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "freeze_public_square_owner_publications"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='enabled' AND NEW.status<>'enabled' THEN
    UPDATE "personal_agent_team_job_publications" p SET state='frozen',owner_left_team=true,
      frozen_status=CASE WHEN j.state IN ('queued','running') AND e.state='failed' THEN 'failed' WHEN j.state IN ('queued','running') AND EXISTS(SELECT 1 FROM "managed_conversation_runtime_items" r WHERE r.execution_id=j.conversation_id AND r.owner_user_id=j.owner_user_id AND r.state='pending' AND r.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')) THEN 'waiting' ELSE j.state END,
      frozen_updated_at=j.updated_at,
      frozen_started_at=(SELECT min(a.started_at) FROM "personal_agent_execution_attempts" a WHERE a.owner_user_id=j.owner_user_id AND a.job_id=j.id),
      frozen_phase=(SELECT a.phase FROM "personal_agent_execution_attempts" a WHERE a.owner_user_id=j.owner_user_id AND a.job_id=j.id ORDER BY a.attempt_number DESC LIMIT 1),
      frozen_phase_observed_at=(SELECT a.phase_observed_at FROM "personal_agent_execution_attempts" a WHERE a.owner_user_id=j.owner_user_id AND a.job_id=j.id ORDER BY a.attempt_number DESC LIMIT 1),
      frozen_last_seen_at=e.runner_last_seen_at,
      frozen_completed_at=CASE WHEN j.state IN ('succeeded','failed','canceled') OR (j.state IN ('queued','running') AND e.state='failed') THEN j.updated_at ELSE NULL END,
      version=p.version+1,updated_at=now()
    FROM "personal_agent_execution_jobs" j
    JOIN "managed_conversation_executions" e ON e.id=j.conversation_id AND e.owner_user_id=j.owner_user_id
    WHERE p.job_id=j.id AND p.owner_user_id=NEW.user_id AND p.team_id=NEW.team_id AND p.state='active';
  END IF;
  RETURN NEW;
END $$;
