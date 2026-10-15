ALTER TABLE "team_overview_reminder_states"
  DROP CONSTRAINT "team_overview_source_kind_check";
--> statement-breakpoint
ALTER TABLE "team_overview_reminder_states"
  ADD CONSTRAINT "team_overview_source_kind_check" CHECK (
    "team_overview_reminder_states"."source_kind" in (
      'message_attention',
      'agent_request',
      'team_job_action',
      'team_job_outcome',
      'team_agent_action',
      'team_agent_outcome',
      'pull_request_action'
    )
  );
