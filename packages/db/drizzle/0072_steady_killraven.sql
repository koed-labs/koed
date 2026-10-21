CREATE TABLE "workspace_project_seen" (
	"workspace_project_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"seen_sequence" bigint DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone,
	"welcome_delivered_at" timestamp with time zone,
	CONSTRAINT "workspace_project_seen_workspace_project_id_team_member_id_pk" PRIMARY KEY("workspace_project_id","team_member_id"),
	CONSTRAINT "workspace_project_seen_sequence_nonnegative" CHECK ("workspace_project_seen"."seen_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" DROP CONSTRAINT "managed_conversation_commands_kind_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" DROP CONSTRAINT "managed_conversation_commands_shape_check";--> statement-breakpoint
ALTER TABLE "workspace_project_seen" ADD CONSTRAINT "workspace_project_seen_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_seen" ADD CONSTRAINT "workspace_project_seen_team_member_id_team_memberships_id_fk" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_kind_check" CHECK ("managed_conversation_commands"."command_kind" in (
        'start',
        'prompt',
        'hq_catch_up',
        'interrupt',
        'quiesce',
        'stop',
        'verify_target',
        'restore',
        'checkpoint_restore',
        'fork_prepare',
        'fork_create',
        'file_browse',
        'file_read',
        'file_search',
        'file_mention'
      ));--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_shape_check" CHECK ("managed_conversation_commands"."sequence" >= 0
        and "managed_conversation_commands"."execution_generation" > 0
        and "managed_conversation_commands"."attempts" >= 0
        and "managed_conversation_commands"."request_digest" ~ '^[0-9a-f]{64}$'
        and (
          ("managed_conversation_commands"."state" = 'blocked'
            and "managed_conversation_commands"."blocked_on_kind" in (
              'source_replica',
              'source_registration',
              'runtime_binding'
            )
            and "managed_conversation_commands"."blocked_on_id" is not null
            and (
              "managed_conversation_commands"."blocked_on_kind" <> 'runtime_binding'
              or (
                "managed_conversation_commands"."command_kind" = 'start'
                and "managed_conversation_commands"."blocked_on_id" = "managed_conversation_commands"."execution_id"
              )
            ))
          or ("managed_conversation_commands"."state" <> 'blocked'
            and "managed_conversation_commands"."blocked_on_kind" is null
            and "managed_conversation_commands"."blocked_on_id" is null)
        )
        and ("managed_conversation_commands"."command_kind" not in (
            'prompt','hq_catch_up','checkpoint_restore','file_browse','file_read','file_search','file_mention'
          ) or "managed_conversation_commands"."encrypted_payload" is not null)
        and (
          ("managed_conversation_commands"."command_kind" in ('prompt','hq_catch_up')
            and "managed_conversation_commands"."client_user_message_id" is not null)
          or ("managed_conversation_commands"."command_kind" not in ('prompt','hq_catch_up') and "managed_conversation_commands"."client_user_message_id" is null)
        )
        and (
          ("managed_conversation_commands"."command_kind" in ('verify_target','restore','fork_create')
            and "managed_conversation_commands"."target_deployment_id" is not null
            and "managed_conversation_commands"."target_device_id" is not null)
          or ("managed_conversation_commands"."command_kind" not in ('verify_target','restore','fork_create')
            and "managed_conversation_commands"."target_deployment_id" is null
            and "managed_conversation_commands"."target_device_id" is null)
        ));