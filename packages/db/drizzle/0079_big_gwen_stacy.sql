ALTER TABLE "team_agent_requests" DROP CONSTRAINT "team_agent_requests_status_shape_check";--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD COLUMN "managed_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD COLUMN "managed_command_id" uuid;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD COLUMN "native_status_frozen" text;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD COLUMN "review_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD COLUMN "review_binding_checked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_owner_managed_execution_fk" FOREIGN KEY ("managed_execution_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_owner_review_execution_fk" FOREIGN KEY ("review_execution_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_id_execution_owner_unique" UNIQUE("id","execution_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_owner_managed_command_fk" FOREIGN KEY ("managed_command_id","managed_execution_id","owner_user_id") REFERENCES "public"."managed_conversation_commands"("id","execution_id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_agent_requests_owner_review_execution_idx" ON "team_agent_requests" USING btree ("owner_user_id","review_execution_id") WHERE "team_agent_requests"."review_execution_id" is not null;--> statement-breakpoint
CREATE INDEX "team_agent_requests_owner_review_unchecked_idx" ON "team_agent_requests" USING btree ("owner_user_id","id") WHERE "team_agent_requests"."review_binding_checked" = false;--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_managed_command_unique" UNIQUE("managed_command_id");--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_native_status_frozen_check" CHECK ("team_agent_requests"."native_status_frozen" is null or (
        "team_agent_requests"."managed_execution_id" is not null
        and "team_agent_requests"."native_status_frozen" in (
          'queued','running','waiting','succeeded','failed','canceled',
          'interrupted','offline','unknown'
        )
      ));--> statement-breakpoint
ALTER TABLE "team_agent_requests" ADD CONSTRAINT "team_agent_requests_status_shape_check" CHECK (("team_agent_requests"."status" = 'accepted'
            and (("team_agent_requests"."job_id" is not null
                  and "team_agent_requests"."managed_execution_id" is null
                  and "team_agent_requests"."managed_command_id" is null)
              or ("team_agent_requests"."job_id" is null
                  and "team_agent_requests"."managed_execution_id" is not null
                  and "team_agent_requests"."managed_command_id" is not null)))
        or ("team_agent_requests"."status" <> 'accepted'
            and "team_agent_requests"."job_id" is null
            and "team_agent_requests"."managed_execution_id" is null
            and "team_agent_requests"."managed_command_id" is null));
--> statement-breakpoint
ALTER TABLE "team_agent_requests" ALTER COLUMN "review_binding_checked" SET DEFAULT true;--> statement-breakpoint
CREATE FUNCTION "team_agent_request_native_execution_status"(p_execution_id uuid,p_command_id uuid,p_owner_user_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN c.id IS NULL OR e.id IS NULL THEN 'unknown'
    WHEN c.state='indeterminate' THEN 'unknown'
    WHEN c.state='completed' THEN CASE WHEN EXISTS (
      SELECT 1 FROM "managed_conversation_runtime_items" ri
       WHERE ri.execution_id=p_execution_id
         AND ri.owner_user_id=p_owner_user_id
         AND ri.execution_generation=c.execution_generation
         AND ri.provider_turn_id=COALESCE(c.result->>'turnId',c.result->>'providerTurnId')
         AND COALESCE(c.result->>'turnId',c.result->>'providerTurnId') IS NOT NULL
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.state='pending'
    ) THEN 'waiting' ELSE 'succeeded' END
    WHEN c.state='failed' THEN 'failed'
    WHEN c.state='canceled' THEN 'canceled'
    WHEN c.execution_generation<>e.execution_generation THEN 'unknown'
    WHEN e.state='fenced' THEN 'unknown'
    WHEN c.state='dispatching' THEN CASE
      WHEN c.lease_expires_at IS NULL OR c.lease_expires_at <= now()
        OR e.runner_lease_expires_at IS NULL OR e.runner_lease_expires_at <= now()
        THEN 'unknown'
      WHEN EXISTS (
        SELECT 1 FROM "managed_conversation_runtime_items" ri
         WHERE ri.execution_id=p_execution_id
           AND ri.owner_user_id=p_owner_user_id
           AND ri.execution_generation=c.execution_generation
           AND ri.provider_turn_id=COALESCE(c.result->>'turnId',c.result->>'providerTurnId')
         AND COALESCE(c.result->>'turnId',c.result->>'providerTurnId') IS NOT NULL
           AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
           AND ri.state='pending'
      ) THEN 'waiting'
      ELSE 'running' END
    WHEN e.state='failed' THEN 'failed'
    WHEN e.state IN ('stopped','stopping') THEN 'interrupted'
    WHEN c.state IN ('queued','blocked') THEN 'queued'
    ELSE 'unknown'
  END
  FROM (SELECT p_execution_id AS id) requested
  LEFT JOIN "managed_conversation_commands" c
    ON c.id=p_command_id AND c.execution_id=p_execution_id AND c.owner_user_id=p_owner_user_id
  LEFT JOIN "managed_conversation_executions" e
    ON e.id=p_execution_id AND e.owner_user_id=p_owner_user_id
$$;--> statement-breakpoint
CREATE FUNCTION "freeze_native_team_agent_request_status"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='enabled' AND (NEW.status<>'enabled' OR NEW.disabled_at IS NOT NULL) THEN
    UPDATE "team_agent_requests" r
       SET native_status_frozen=COALESCE(
         r.native_status_frozen,
         "team_agent_request_native_execution_status"(
           r.managed_execution_id,r.managed_command_id,r.owner_user_id
         )
       )
     WHERE r.team_id=NEW.team_id AND r.owner_user_id=NEW.user_id
       AND r.status='accepted'
       AND r.managed_execution_id IS NOT NULL
       AND r.managed_command_id IS NOT NULL
       AND r.native_status_frozen IS NULL;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_agent_requests_freeze_native_owner_status"
AFTER UPDATE OF "status","disabled_at" ON "team_memberships"
FOR EACH ROW EXECUTE FUNCTION "freeze_native_team_agent_request_status"();--> statement-breakpoint
