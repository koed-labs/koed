ALTER TABLE "home_reminder_states"
  DROP CONSTRAINT "home_reminder_source_kind_check";
--> statement-breakpoint
ALTER TABLE "home_reminder_states"
  ADD CONSTRAINT "home_reminder_source_kind_check" CHECK (
    "home_reminder_states"."source_kind" in (
      'managed_runtime_item',
      'managed_execution',
      'personal_agent_job',
      'native_agent_activity',
      'pull_request_review'
    )
  );
