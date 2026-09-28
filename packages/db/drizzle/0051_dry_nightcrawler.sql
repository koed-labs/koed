ALTER TYPE "public"."collaboration_thread_kind" ADD VALUE 'team_channel' BEFORE 'workspace_channel';--> statement-breakpoint
ALTER TYPE "public"."collaboration_thread_kind" ADD VALUE 'team_project_channel' BEFORE 'workspace_channel';--> statement-breakpoint
CREATE TABLE "collaboration_team_shared_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"creation_request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_team_shared_projects_id_team_unique" UNIQUE("id","team_id"),
	CONSTRAINT "collaboration_team_shared_projects_request_hash_check" CHECK (length("collaboration_team_shared_projects"."creation_request_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_shape_check";--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_system_key_check";--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD COLUMN "team_project_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_team_shared_projects" ADD CONSTRAINT "collaboration_team_shared_projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_team_shared_projects" ADD CONSTRAINT "collaboration_team_shared_projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collaboration_team_shared_projects_team_created_idx" ON "collaboration_team_shared_projects" USING btree ("team_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_project_team_fk" FOREIGN KEY ("team_project_id","team_id") REFERENCES "public"."collaboration_team_shared_projects"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_team_channel_active_unique" ON "collaboration_threads" USING btree ("team_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'team_channel' and "collaboration_threads"."system_key" is null and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_team_system_key_unique" ON "collaboration_threads" USING btree ("team_id","system_key") WHERE "collaboration_threads"."kind" = 'team_channel' and "collaboration_threads"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_team_project_channel_unique" ON "collaboration_threads" USING btree ("team_project_id") WHERE "collaboration_threads"."kind" = 'team_project_channel';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_team_project_name_active_unique" ON "collaboration_threads" USING btree ("team_project_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'team_project_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_shape_check" CHECK ((
        "collaboration_threads"."scope" = 'personal'
        and "collaboration_threads"."kind" = 'personal_channel'
        and "collaboration_threads"."personal_owner_user_id" is not null
        and "collaboration_threads"."team_id" is null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."team_project_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
        and length("collaboration_threads"."normalized_name_hash") = 64
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'team_channel'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."team_project_id" is null
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
        and (
          ("collaboration_threads"."system_key" is null
            and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
            and length("collaboration_threads"."normalized_name_hash") = 64)
          or ("collaboration_threads"."system_key" = 'team.general'
            and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
            and length("collaboration_threads"."normalized_name_hash") = 64)
        )
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'team_project_channel'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."team_project_id" is not null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
        and length("collaboration_threads"."normalized_name_hash") = 64
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'workspace_channel'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is not null
        and "collaboration_threads"."team_project_id" is null
        and (
          (
            "collaboration_threads"."system_key" is null
            and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
            and length("collaboration_threads"."normalized_name_hash") = 64
          )
          or (
            "collaboration_threads"."system_key" = 'workspace.general'
            and (
              ("collaboration_threads"."name_marker" is null and "collaboration_threads"."normalized_name_hash" is null)
              or ("collaboration_threads"."name_marker" = '[koed encrypted collaboration name]' and length("collaboration_threads"."normalized_name_hash") = 64)
            )
          )
        )
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" in ('dm', 'group_dm')
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."team_project_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" is null
        and "collaboration_threads"."topic_marker" is null
        and "collaboration_threads"."normalized_name_hash" is null
        and length("collaboration_threads"."participant_key") = 64
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'shared_session_discussion'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is not null
        and "collaboration_threads"."team_project_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" is null
        and "collaboration_threads"."topic_marker" is null
        and "collaboration_threads"."normalized_name_hash" is null
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is not null
        and "collaboration_threads"."share_grant_id" is not null
      ));--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_system_key_check" CHECK ("collaboration_threads"."system_key" is null or "collaboration_threads"."system_key" in ('workspace.general', 'team.general'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_collaboration_participant_set"("target_thread_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_thread collaboration_threads%ROWTYPE;
  participant_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  distinct_ordinals integer;
  calculated_participant_key text;
BEGIN
  SELECT * INTO target_thread FROM collaboration_threads
   WHERE id = target_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*)::integer, min(ordinal), max(ordinal), count(DISTINCT ordinal)::integer
    INTO participant_count, minimum_ordinal, maximum_ordinal, distinct_ordinals
    FROM collaboration_participants WHERE thread_id = target_thread_id;

  IF target_thread.kind IN (
    'personal_channel', 'team_channel', 'team_project_channel',
    'workspace_channel', 'shared_session_discussion'
  ) THEN
    IF participant_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
        MESSAGE = 'Channel participant set must be implicit';
    END IF;
    RETURN;
  END IF;
  IF target_thread.kind = 'dm' AND participant_count <> 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Direct message participant set is invalid';
  END IF;
  IF target_thread.kind = 'group_dm' AND (participant_count < 3 OR participant_count > 40) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Group direct message participant set is invalid';
  END IF;
  IF target_thread.kind NOT IN ('dm', 'group_dm') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration thread kind has no participant invariant';
  END IF;
  IF minimum_ordinal <> 0 OR maximum_ordinal <> participant_count - 1
     OR distinct_ordinals <> participant_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant ordinals are invalid';
  END IF;

  SELECT encode(digest(
           E'koed:collaboration:participants:v1\n'
           || '{"teamId":"' || target_thread.team_id::text || '","userIds":['
           || string_agg('"' || participant.user_id::text || '"', ',' ORDER BY participant.user_id::text)
           || ']}', 'sha256'), 'hex')
    INTO calculated_participant_key
    FROM collaboration_participants participant WHERE participant.thread_id = target_thread_id;

  IF calculated_participant_key IS DISTINCT FROM target_thread.participant_key THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant identity is invalid';
  END IF;
END;
$$;
