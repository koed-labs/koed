ALTER TABLE "managed_conversation_executions" DROP CONSTRAINT "managed_conversation_executions_identity_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_identity_check" CHECK ((
        "managed_conversation_executions"."state" = 'starting'
        and "managed_conversation_executions"."logical_session_id" is null
        and "managed_conversation_executions"."provider_thread_id" is null
      ) or (
        "managed_conversation_executions"."state" <> 'starting'
        and (
          "managed_conversation_executions"."state" = 'failed'
          or (
            "managed_conversation_executions"."state" = 'stopped'
            and "managed_conversation_executions"."logical_session_id" is null
            and "managed_conversation_executions"."provider_thread_id" is null
          )
          or (
            "managed_conversation_executions"."logical_session_id" is not null
            and "managed_conversation_executions"."provider_thread_id" is not null
          )
        )
      ));
