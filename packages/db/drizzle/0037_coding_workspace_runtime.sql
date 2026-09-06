CREATE TYPE "public"."conversation_presentation_mode" AS ENUM('automatic', 'active', 'settled');--> statement-breakpoint
CREATE TABLE "conversation_presentation_policy_rules" (
	"source_kind" text NOT NULL,
	"source_adapter_version" text NOT NULL,
	"item_type" text NOT NULL,
	"description" text,
	"presentation_mode" text DEFAULT 'hidden' NOT NULL,
	"renderer_kind" text DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_presentation_policy_rules_source_kind_source_adapter_version_item_type_pk" PRIMARY KEY("source_kind","source_adapter_version","item_type"),
	CONSTRAINT "conversation_presentation_policy_mode_check" CHECK ("conversation_presentation_policy_rules"."presentation_mode" in ('expanded','collapsed','status','hidden')),
	CONSTRAINT "conversation_presentation_policy_renderer_check" CHECK ("conversation_presentation_policy_rules"."renderer_kind" in (
        'message','reasoning_summary','tool_call','tool_result','approval',
        'user_input','lifecycle','telemetry','generic'
      )),
	CONSTRAINT "conversation_presentation_policy_hidden_renderer_check" CHECK ("conversation_presentation_policy_rules"."presentation_mode" <> 'hidden' or "conversation_presentation_policy_rules"."renderer_kind" = 'generic')
);
--> statement-breakpoint
CREATE TABLE "conversation_presentation_policy_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_presentation_policy_state_singleton_check" CHECK ("conversation_presentation_policy_state"."id" = 1),
	CONSTRAINT "conversation_presentation_policy_state_revision_check" CHECK ("conversation_presentation_policy_state"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_presentation_states" (
	"owner_user_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone,
	"display_mode" "conversation_presentation_mode" DEFAULT 'automatic' NOT NULL,
	"snoozed_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_presentation_states_owner_session_pk" PRIMARY KEY("owner_user_id","logical_session_id"),
	CONSTRAINT "conversation_presentation_states_snooze_shape_check" CHECK (("conversation_presentation_states"."snoozed_at" is null and "conversation_presentation_states"."snoozed_until" is null)
        or ("conversation_presentation_states"."snoozed_at" is not null and "conversation_presentation_states"."snoozed_until" > "conversation_presentation_states"."snoozed_at")),
	CONSTRAINT "conversation_presentation_states_version_check" CHECK ("conversation_presentation_states"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_execution_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"command_id" uuid NOT NULL,
	"provider_turn_id" text,
	"source_generation_id" uuid,
	"sequence" integer NOT NULL,
	"checkpoint_kind" text NOT NULL,
	"checkpoint_status" text NOT NULL,
	"failure_code" text,
	"repository_identity_hash" text,
	"worktree_identity_hash" text,
	"vcs_driver" text,
	"checkpoint_ref" text,
	"commit_object_id" text,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_conversation_checkpoint_sequence_unique" UNIQUE("execution_id","execution_generation","sequence","checkpoint_kind"),
	CONSTRAINT "managed_conversation_checkpoint_command_kind_unique" UNIQUE("command_id","checkpoint_kind"),
	CONSTRAINT "managed_conversation_checkpoint_shape_check" CHECK ("managed_conversation_execution_checkpoints"."execution_generation" > 0
        and "managed_conversation_execution_checkpoints"."sequence" >= 0
        and "managed_conversation_execution_checkpoints"."checkpoint_kind" in ('baseline','terminal','recovery')
        and "managed_conversation_execution_checkpoints"."checkpoint_status" in ('pending','ready','failed','unsupported')
        and ("managed_conversation_execution_checkpoints"."provider_turn_id" is null or length("managed_conversation_execution_checkpoints"."provider_turn_id") <= 512)
        and ("managed_conversation_execution_checkpoints"."failure_code" is null or "managed_conversation_execution_checkpoints"."failure_code" ~ '^[A-Za-z][A-Za-z0-9_.-]{0,119}$')
        and ("managed_conversation_execution_checkpoints"."checkpoint_kind" <> 'terminal' or "managed_conversation_execution_checkpoints"."source_generation_id" is not null)
        and (
          ("managed_conversation_execution_checkpoints"."checkpoint_status" = 'ready'
            and "managed_conversation_execution_checkpoints"."vcs_driver" = 'git'
            and "managed_conversation_execution_checkpoints"."repository_identity_hash" ~ '^[0-9a-f]{64}$'
            and "managed_conversation_execution_checkpoints"."worktree_identity_hash" ~ '^[0-9a-f]{64}$'
            and "managed_conversation_execution_checkpoints"."commit_object_id" ~ '^[0-9a-f]{40,64}$'
            and "managed_conversation_execution_checkpoints"."checkpoint_ref" =
              'refs/koed/checkpoints/' || "managed_conversation_execution_checkpoints"."execution_id"::text || '/' ||
              "managed_conversation_execution_checkpoints"."execution_generation"::text || '/' || "managed_conversation_execution_checkpoints"."sequence"::text || '/' || "managed_conversation_execution_checkpoints"."checkpoint_kind"
            and "managed_conversation_execution_checkpoints"."captured_at" is not null
            and "managed_conversation_execution_checkpoints"."failure_code" is null)
          or ("managed_conversation_execution_checkpoints"."checkpoint_status" = 'unsupported'
            and "managed_conversation_execution_checkpoints"."vcs_driver" is null
            and "managed_conversation_execution_checkpoints"."repository_identity_hash" is null
            and "managed_conversation_execution_checkpoints"."worktree_identity_hash" is null
            and "managed_conversation_execution_checkpoints"."checkpoint_ref" is null
            and "managed_conversation_execution_checkpoints"."commit_object_id" is null
            and "managed_conversation_execution_checkpoints"."captured_at" is null
            and "managed_conversation_execution_checkpoints"."failure_code" is null)
          or ("managed_conversation_execution_checkpoints"."checkpoint_status" = 'pending'
            and "managed_conversation_execution_checkpoints"."checkpoint_ref" is null
            and "managed_conversation_execution_checkpoints"."commit_object_id" is null
            and "managed_conversation_execution_checkpoints"."captured_at" is null
            and "managed_conversation_execution_checkpoints"."failure_code" is null)
          or ("managed_conversation_execution_checkpoints"."checkpoint_status" = 'failed'
            and "managed_conversation_execution_checkpoints"."checkpoint_ref" is null
            and "managed_conversation_execution_checkpoints"."commit_object_id" is null
            and "managed_conversation_execution_checkpoints"."captured_at" is null
            and "managed_conversation_execution_checkpoints"."failure_code" is not null)
        ))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_execution_diffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"scope_key" text NOT NULL,
	"diff_scope" text NOT NULL,
	"from_checkpoint_id" uuid NOT NULL,
	"to_checkpoint_id" uuid NOT NULL,
	"revision_digest" text NOT NULL,
	"complete" boolean NOT NULL,
	"truncated" boolean NOT NULL,
	"file_count" integer NOT NULL,
	"byte_count" integer NOT NULL,
	"payload_digest" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_conversation_diff_scope_unique" UNIQUE("execution_id","execution_generation","scope_key"),
	CONSTRAINT "managed_conversation_diff_shape_check" CHECK ("managed_conversation_execution_diffs"."execution_generation" > 0
        and (
          ("managed_conversation_execution_diffs"."diff_scope" = 'full' and "managed_conversation_execution_diffs"."scope_key" = 'full')
          or ("managed_conversation_execution_diffs"."diff_scope" = 'turn'
            and "managed_conversation_execution_diffs"."scope_key" ~ '^turn:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        )
        and "managed_conversation_execution_diffs"."revision_digest" ~ '^[0-9a-f]{64}$'
        and "managed_conversation_execution_diffs"."payload_digest" ~ '^[0-9a-f]{64}$'
        and "managed_conversation_execution_diffs"."file_count" between 0 and 25000
        and "managed_conversation_execution_diffs"."byte_count" between 0 and 16777216
        and (not "managed_conversation_execution_diffs"."complete" or not "managed_conversation_execution_diffs"."truncated"))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_runtime_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"provider_request_id" text NOT NULL,
	"provider_turn_id" text,
	"provider_item_id" text,
	"item_kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"request_digest" text NOT NULL,
	"encrypted_payload" jsonb NOT NULL,
	"encrypted_response" jsonb,
	"response_digest" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "managed_conversation_runtime_items_provider_unique" UNIQUE("owner_user_id","execution_id","execution_generation","provider_request_id"),
	CONSTRAINT "managed_conversation_runtime_items_kind_check" CHECK ("managed_conversation_runtime_items"."item_kind" in (
        'command_approval',
        'file_approval',
        'permissions_approval',
        'user_input',
        'transient_output'
      )),
	CONSTRAINT "managed_conversation_runtime_items_state_check" CHECK ("managed_conversation_runtime_items"."state" in ('pending','answered','resolved','canceled')),
	CONSTRAINT "managed_conversation_runtime_items_shape_check" CHECK ("managed_conversation_runtime_items"."execution_generation" > 0
        and "managed_conversation_runtime_items"."revision" > 0
        and length(trim("managed_conversation_runtime_items"."provider_request_id")) > 0
        and length("managed_conversation_runtime_items"."provider_request_id") <= 512
        and ("managed_conversation_runtime_items"."provider_turn_id" is null or length("managed_conversation_runtime_items"."provider_turn_id") <= 512)
        and ("managed_conversation_runtime_items"."provider_item_id" is null or length("managed_conversation_runtime_items"."provider_item_id") <= 512)
        and "managed_conversation_runtime_items"."request_digest" ~ '^[0-9a-f]{64}$'
        and ("managed_conversation_runtime_items"."response_digest" is null or "managed_conversation_runtime_items"."response_digest" ~ '^[0-9a-f]{64}$')
        and (
          ("managed_conversation_runtime_items"."state" = 'pending'
            and "managed_conversation_runtime_items"."encrypted_response" is null
            and "managed_conversation_runtime_items"."response_digest" is null
            and "managed_conversation_runtime_items"."responded_at" is null
            and "managed_conversation_runtime_items"."resolved_at" is null)
          or ("managed_conversation_runtime_items"."state" = 'answered'
            and "managed_conversation_runtime_items"."item_kind" <> 'transient_output'
            and "managed_conversation_runtime_items"."encrypted_response" is not null
            and "managed_conversation_runtime_items"."response_digest" is not null
            and "managed_conversation_runtime_items"."responded_at" is not null
            and "managed_conversation_runtime_items"."resolved_at" is null)
          or ("managed_conversation_runtime_items"."state" in ('resolved','canceled')
            and "managed_conversation_runtime_items"."resolved_at" is not null)
        ))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runner_deployment_id" uuid NOT NULL,
	"runner_device_id" uuid NOT NULL,
	"lifecycle_generation" integer DEFAULT 1 NOT NULL,
	"shell_profile_id" text NOT NULL,
	"state" text DEFAULT 'creating' NOT NULL,
	"columns" integer NOT NULL,
	"rows" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"exit_code" integer,
	"exit_signal" integer,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"detached_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_conversation_terminals_owner_idempotency_unique" UNIQUE("owner_user_id","execution_id","idempotency_key"),
	CONSTRAINT "managed_conversation_terminals_shape_check" CHECK ("managed_conversation_terminals"."execution_generation" > 0
        and "managed_conversation_terminals"."lifecycle_generation" > 0
        and "managed_conversation_terminals"."shell_profile_id" = 'system_default'
        and "managed_conversation_terminals"."state" in ('creating', 'running', 'detached', 'stopping', 'unknown', 'exited', 'failed')
        and "managed_conversation_terminals"."columns" between 20 and 500
        and "managed_conversation_terminals"."rows" between 5 and 300
        and length(trim("managed_conversation_terminals"."idempotency_key")) between 16 and 160
        and "managed_conversation_terminals"."request_digest" ~ '^[0-9a-f]{64}$'
        and ("managed_conversation_terminals"."failure_code" is null or "managed_conversation_terminals"."failure_code" ~ '^[A-Za-z][A-Za-z0-9_.-]{0,119}$')),
	CONSTRAINT "managed_conversation_terminals_lifecycle_check" CHECK (("managed_conversation_terminals"."state" = 'creating'
          and "managed_conversation_terminals"."started_at" is null
          and "managed_conversation_terminals"."stopped_at" is null
          and "managed_conversation_terminals"."exit_code" is null
          and "managed_conversation_terminals"."exit_signal" is null
          and "managed_conversation_terminals"."failure_code" is null)
        or ("managed_conversation_terminals"."state" in ('running', 'detached', 'stopping')
          and "managed_conversation_terminals"."started_at" is not null
          and "managed_conversation_terminals"."stopped_at" is null
          and "managed_conversation_terminals"."exit_code" is null
          and "managed_conversation_terminals"."exit_signal" is null
          and "managed_conversation_terminals"."failure_code" is null)
        or ("managed_conversation_terminals"."state" = 'unknown'
          and "managed_conversation_terminals"."started_at" is not null
          and "managed_conversation_terminals"."stopped_at" is null
          and "managed_conversation_terminals"."exit_code" is null
          and "managed_conversation_terminals"."exit_signal" is null
          and "managed_conversation_terminals"."failure_code" is not null)
        or ("managed_conversation_terminals"."state" = 'exited'
          and "managed_conversation_terminals"."started_at" is not null
          and "managed_conversation_terminals"."stopped_at" is not null
          and "managed_conversation_terminals"."exit_code" is not null
          and "managed_conversation_terminals"."failure_code" is null)
        or ("managed_conversation_terminals"."state" = 'failed'
          and "managed_conversation_terminals"."stopped_at" is not null
          and "managed_conversation_terminals"."exit_code" is null
          and "managed_conversation_terminals"."exit_signal" is null
          and "managed_conversation_terminals"."failure_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "realtime_transport_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_hash" text NOT NULL,
	"ticket_version" integer NOT NULL,
	"transport" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"auth_kind" text NOT NULL,
	"user_session_id" uuid,
	"device_credential_id" uuid,
	"backend_identity_hash" text NOT NULL,
	"client_instance_hash" text NOT NULL,
	"client_kind" text NOT NULL,
	"origin_hash" text,
	"native_binding_hash" text,
	"operation_families" text[] NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"connection_id_hash" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "realtime_transport_tickets_secret_unique" UNIQUE("secret_hash"),
	CONSTRAINT "realtime_transport_tickets_shape_check" CHECK ("realtime_transport_tickets"."ticket_version" > 0
        and "realtime_transport_tickets"."protocol_version" > 0
        and "realtime_transport_tickets"."transport" in ('webtransport','websocket')
        and "realtime_transport_tickets"."auth_kind" in ('session','device_credential')
        and "realtime_transport_tickets"."client_kind" in ('browser','native')
        and length("realtime_transport_tickets"."secret_hash") = 64
        and length("realtime_transport_tickets"."backend_identity_hash") = 64
        and length("realtime_transport_tickets"."client_instance_hash") = 64
        and ("realtime_transport_tickets"."origin_hash" is null or length("realtime_transport_tickets"."origin_hash") = 64)
        and ("realtime_transport_tickets"."native_binding_hash" is null or length("realtime_transport_tickets"."native_binding_hash") = 64)
        and ("realtime_transport_tickets"."connection_id_hash" is null or length("realtime_transport_tickets"."connection_id_hash") = 64)
        and cardinality("realtime_transport_tickets"."operation_families") > 0
        and array_position("realtime_transport_tickets"."operation_families", null) is null
        and "realtime_transport_tickets"."expires_at" > "realtime_transport_tickets"."issued_at"
        and (("realtime_transport_tickets"."auth_kind" = 'session'
          and "realtime_transport_tickets"."user_session_id" is not null
          and "realtime_transport_tickets"."device_credential_id" is null
          and "realtime_transport_tickets"."client_kind" = 'browser'
          and "realtime_transport_tickets"."origin_hash" is not null
          and "realtime_transport_tickets"."native_binding_hash" is null)
        or ("realtime_transport_tickets"."auth_kind" = 'device_credential'
          and "realtime_transport_tickets"."user_session_id" is null
          and "realtime_transport_tickets"."device_credential_id" is not null
          and "realtime_transport_tickets"."client_kind" = 'native'
          and "realtime_transport_tickets"."origin_hash" is null
          and "realtime_transport_tickets"."native_binding_hash" is not null))
        and (("realtime_transport_tickets"."consumed_at" is null and "realtime_transport_tickets"."connection_id_hash" is null)
          or ("realtime_transport_tickets"."consumed_at" is not null and "realtime_transport_tickets"."connection_id_hash" is not null)))
);
--> statement-breakpoint
CREATE TABLE "pds_peer_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"record_hash" text NOT NULL,
	"canonical_advertisement" text NOT NULL,
	"canonical_request_proof" text NOT NULL,
	"advertised_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_peer_route_device_unique" UNIQUE("group_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" DROP CONSTRAINT "managed_conversation_commands_kind_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" DROP CONSTRAINT "managed_conversation_commands_shape_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" DROP CONSTRAINT "managed_conversation_executions_provider_check";--> statement-breakpoint
ALTER TABLE "projection_policy_rules" DROP CONSTRAINT "projection_policy_rules_message_ui_check";--> statement-breakpoint
ALTER TABLE "projection_policy_rules" DROP CONSTRAINT "projection_policy_rules_tool_ui_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "model" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "permission_mode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "runner_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "source_project_path" text NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "workspace_kind" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "workspace_lifecycle" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "cleanup_state" text DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "vcs_driver" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "local_repository_common_directory" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "local_git_directory" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "repository_identity_hash" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "worktree_identity_hash" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "base_object_id" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "branch_ref" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "head_object_id" text;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD COLUMN "creation_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "presentation_policy_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "presentation_policy_revision" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "presentation_mode" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "presentation_renderer" text;--> statement-breakpoint
ALTER TABLE "tool_events" ADD COLUMN "presentation_policy_key" text;--> statement-breakpoint
ALTER TABLE "tool_events" ADD COLUMN "presentation_policy_revision" bigint;--> statement-breakpoint
ALTER TABLE "tool_events" ADD COLUMN "presentation_mode" text;--> statement-breakpoint
ALTER TABLE "tool_events" ADD COLUMN "presentation_renderer" text;--> statement-breakpoint
ALTER TABLE "pds_relay_recipients" ADD COLUMN "canonical_ack" text;--> statement-breakpoint
ALTER TABLE "conversation_presentation_states" ADD CONSTRAINT "conversation_presentation_states_owner_session_fk" FOREIGN KEY ("owner_user_id","logical_session_id") REFERENCES "public"."sessions"("owner_user_id","logical_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_checkpoints" ADD CONSTRAINT "managed_conversation_execution_checkpoints_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_checkpoints" ADD CONSTRAINT "managed_conversation_execution_checkpoints_execution_id_managed_conversation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."managed_conversation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_checkpoints" ADD CONSTRAINT "managed_conversation_execution_checkpoints_command_id_managed_conversation_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."managed_conversation_commands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_diffs" ADD CONSTRAINT "managed_conversation_execution_diffs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_diffs" ADD CONSTRAINT "managed_conversation_execution_diffs_execution_id_managed_conversation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."managed_conversation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_diffs" ADD CONSTRAINT "managed_conversation_execution_diffs_from_checkpoint_id_managed_conversation_execution_checkpoints_id_fk" FOREIGN KEY ("from_checkpoint_id") REFERENCES "public"."managed_conversation_execution_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_execution_diffs" ADD CONSTRAINT "managed_conversation_execution_diffs_to_checkpoint_id_managed_conversation_execution_checkpoints_id_fk" FOREIGN KEY ("to_checkpoint_id") REFERENCES "public"."managed_conversation_execution_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_items" ADD CONSTRAINT "managed_conversation_runtime_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_items" ADD CONSTRAINT "managed_conversation_runtime_items_execution_id_managed_conversation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."managed_conversation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_terminals" ADD CONSTRAINT "managed_conversation_terminals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_terminals" ADD CONSTRAINT "managed_conversation_terminals_execution_id_managed_conversation_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."managed_conversation_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_transport_tickets" ADD CONSTRAINT "realtime_transport_tickets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_id_user_unique" UNIQUE("id","user_id");--> statement-breakpoint
ALTER TABLE "realtime_transport_tickets" ADD CONSTRAINT "realtime_transport_tickets_session_owner_fk" FOREIGN KEY ("user_session_id","owner_user_id") REFERENCES "public"."user_sessions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_transport_tickets" ADD CONSTRAINT "realtime_transport_tickets_device_owner_fk" FOREIGN KEY ("device_credential_id","owner_user_id") REFERENCES "public"."device_credentials"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_peer_routes" ADD CONSTRAINT "pds_peer_routes_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_presentation_policy_lookup_idx" ON "conversation_presentation_policy_rules" USING btree ("source_kind","source_adapter_version","item_type","enabled");--> statement-breakpoint
CREATE INDEX "conversation_presentation_states_owner_pinned_idx" ON "conversation_presentation_states" USING btree ("owner_user_id","pinned_at");--> statement-breakpoint
CREATE INDEX "managed_conversation_checkpoint_execution_idx" ON "managed_conversation_execution_checkpoints" USING btree ("owner_user_id","execution_id","execution_generation","sequence");--> statement-breakpoint
CREATE INDEX "managed_conversation_diff_execution_idx" ON "managed_conversation_execution_diffs" USING btree ("owner_user_id","execution_id","execution_generation","updated_at");--> statement-breakpoint
CREATE INDEX "managed_conversation_runtime_items_active_idx" ON "managed_conversation_runtime_items" USING btree ("owner_user_id","execution_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "managed_conversation_terminals_execution_state_idx" ON "managed_conversation_terminals" USING btree ("owner_user_id","execution_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "managed_conversation_terminals_runner_state_idx" ON "managed_conversation_terminals" USING btree ("runner_deployment_id","runner_device_id","state");--> statement-breakpoint
CREATE INDEX "realtime_transport_tickets_active_idx" ON "realtime_transport_tickets" USING btree ("owner_user_id","expires_at") WHERE "realtime_transport_tickets"."consumed_at" is null and "realtime_transport_tickets"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "realtime_transport_tickets_expiry_idx" ON "realtime_transport_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "realtime_transport_tickets_session_idx" ON "realtime_transport_tickets" USING btree ("user_session_id");--> statement-breakpoint
CREATE INDEX "realtime_transport_tickets_device_idx" ON "realtime_transport_tickets" USING btree ("device_credential_id");--> statement-breakpoint
CREATE INDEX "pds_peer_route_expiry_idx" ON "pds_peer_routes" USING btree ("group_id","expires_at");--> statement-breakpoint
CREATE INDEX "managed_conversation_runtime_binding_preparation_idx" ON "managed_conversation_runtime_bindings" USING btree ("deployment_id","device_id","workspace_lifecycle","created_at");--> statement-breakpoint
CREATE INDEX "managed_conversation_runtime_binding_cleanup_idx" ON "managed_conversation_runtime_bindings" USING btree ("deployment_id","device_id","workspace_lifecycle","cleanup_state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_conversation_runtime_binding_active_path_unique" ON "managed_conversation_runtime_bindings" USING btree ("project_path") WHERE "managed_conversation_runtime_bindings"."workspace_kind" = 'koed_managed_worktree'
          and "managed_conversation_runtime_bindings"."workspace_lifecycle" in ('ready', 'cleanup_requested');--> statement-breakpoint
ALTER TABLE "projection_policy_rules" DROP COLUMN "project_to_ui";--> statement-breakpoint
ALTER TABLE "projection_policy_rules" DROP COLUMN "create_message";--> statement-breakpoint
ALTER TABLE "projection_policy_rules" DROP COLUMN "create_tool_event";--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_checkpoint_pending_check" CHECK (("managed_conversation_commands"."result"->>'phase') is distinct from 'checkpoint_pending'
        or (
          "managed_conversation_commands"."command_kind" = 'prompt'
          and "managed_conversation_commands"."state" in ('queued','dispatching')
          and ("managed_conversation_commands"."result"->>'sourceGenerationId') ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and (
            "managed_conversation_commands"."result"->'providerTurnId' = 'null'::jsonb
            or (
              jsonb_typeof("managed_conversation_commands"."result"->'providerTurnId') = 'string'
              and length(trim("managed_conversation_commands"."result"->>'providerTurnId')) between 1 and 512
            )
          )
        ));--> statement-breakpoint
ALTER TABLE "managed_conversation_commands" ADD CONSTRAINT "managed_conversation_commands_kind_check" CHECK ("managed_conversation_commands"."command_kind" in (
        'start',
        'prompt',
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
            'prompt','checkpoint_restore','file_browse','file_read','file_search','file_mention'
          ) or "managed_conversation_commands"."encrypted_payload" is not null)
        and (
          ("managed_conversation_commands"."command_kind" = 'prompt'
            and "managed_conversation_commands"."client_user_message_id" is not null)
          or ("managed_conversation_commands"."command_kind" <> 'prompt' and "managed_conversation_commands"."client_user_message_id" is null)
        )
        and (
          ("managed_conversation_commands"."command_kind" in ('verify_target','restore','fork_create')
            and "managed_conversation_commands"."target_deployment_id" is not null
            and "managed_conversation_commands"."target_device_id" is not null)
          or ("managed_conversation_commands"."command_kind" not in ('verify_target','restore','fork_create')
            and "managed_conversation_commands"."target_deployment_id" is null
            and "managed_conversation_commands"."target_device_id" is null)
        ));--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_provider_check" CHECK ("managed_conversation_executions"."provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and "managed_conversation_executions"."ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and length(trim("managed_conversation_executions"."model")) between 1 and 512
        and ("managed_conversation_executions"."reasoning_effort" is null or length(trim("managed_conversation_executions"."reasoning_effort")) between 1 and 64)
        and "managed_conversation_executions"."permission_mode" in ('supervised', 'auto_edit', 'auto', 'full_access')
        and "managed_conversation_executions"."runner_kind" = 'local_device');--> statement-breakpoint
ALTER TABLE "managed_conversation_runtime_bindings" ADD CONSTRAINT "managed_conversation_runtime_binding_workspace_check" CHECK ((("managed_conversation_runtime_bindings"."workspace_lifecycle" = 'pending'
          and "managed_conversation_runtime_bindings"."workspace_id" is null
          and "managed_conversation_runtime_bindings"."workspace_kind" = 'pending'
          and "managed_conversation_runtime_bindings"."creation_operation_id" is null
          and "managed_conversation_runtime_bindings"."vcs_driver" is null
          and "managed_conversation_runtime_bindings"."local_repository_common_directory" is null
          and "managed_conversation_runtime_bindings"."local_git_directory" is null
          and "managed_conversation_runtime_bindings"."repository_identity_hash" is null
          and "managed_conversation_runtime_bindings"."worktree_identity_hash" is null
          and "managed_conversation_runtime_bindings"."base_ref" is null
          and "managed_conversation_runtime_bindings"."base_object_id" is null
          and "managed_conversation_runtime_bindings"."branch_ref" is null
          and "managed_conversation_runtime_bindings"."head_object_id" is null)
        or ("managed_conversation_runtime_bindings"."workspace_lifecycle" in ('ready', 'cleanup_requested', 'removed', 'cleanup_failed', 'orphaned')
          and "managed_conversation_runtime_bindings"."workspace_id" is not null
          and "managed_conversation_runtime_bindings"."workspace_kind" in ('koed_managed_worktree', 'user_managed_checkout', 'non_vcs_directory')
          and "managed_conversation_runtime_bindings"."creation_operation_id" is not null
          and (("managed_conversation_runtime_bindings"."workspace_kind" = 'non_vcs_directory'
              and "managed_conversation_runtime_bindings"."vcs_driver" is null
              and "managed_conversation_runtime_bindings"."local_repository_common_directory" is null
              and "managed_conversation_runtime_bindings"."local_git_directory" is null
              and "managed_conversation_runtime_bindings"."repository_identity_hash" is null
              and "managed_conversation_runtime_bindings"."worktree_identity_hash" is null
              and "managed_conversation_runtime_bindings"."base_ref" is null
              and "managed_conversation_runtime_bindings"."base_object_id" is null
              and "managed_conversation_runtime_bindings"."branch_ref" is null
              and "managed_conversation_runtime_bindings"."head_object_id" is null)
            or ("managed_conversation_runtime_bindings"."workspace_kind" in ('koed_managed_worktree', 'user_managed_checkout')
              and "managed_conversation_runtime_bindings"."vcs_driver" = 'git'
              and length(trim("managed_conversation_runtime_bindings"."local_repository_common_directory")) > 0
              and length(trim("managed_conversation_runtime_bindings"."local_git_directory")) > 0
              and "managed_conversation_runtime_bindings"."repository_identity_hash" is not null
              and "managed_conversation_runtime_bindings"."worktree_identity_hash" is not null
              and "managed_conversation_runtime_bindings"."head_object_id" is not null
              and ("managed_conversation_runtime_bindings"."workspace_kind" <> 'koed_managed_worktree'
                or ("managed_conversation_runtime_bindings"."base_ref" is not null
                  and "managed_conversation_runtime_bindings"."base_object_id" is not null
                  and "managed_conversation_runtime_bindings"."branch_ref" is not null))))))
        and (("managed_conversation_runtime_bindings"."workspace_lifecycle" in ('pending', 'ready')
            and "managed_conversation_runtime_bindings"."cleanup_state" = 'not_requested')
          or ("managed_conversation_runtime_bindings"."workspace_lifecycle" = 'cleanup_requested'
            and "managed_conversation_runtime_bindings"."cleanup_state" = 'requested')
          or ("managed_conversation_runtime_bindings"."workspace_lifecycle" = 'removed'
            and "managed_conversation_runtime_bindings"."cleanup_state" = 'completed')
          or ("managed_conversation_runtime_bindings"."workspace_lifecycle" in ('cleanup_failed', 'orphaned')
            and "managed_conversation_runtime_bindings"."cleanup_state" = 'failed'))
        and length(trim("managed_conversation_runtime_bindings"."source_project_path")) > 0
        and length(trim("managed_conversation_runtime_bindings"."project_path")) > 0
        and ("managed_conversation_runtime_bindings"."repository_identity_hash" is null or "managed_conversation_runtime_bindings"."repository_identity_hash" ~ '^[0-9a-f]{64}$')
        and ("managed_conversation_runtime_bindings"."worktree_identity_hash" is null or "managed_conversation_runtime_bindings"."worktree_identity_hash" ~ '^[0-9a-f]{64}$')
        and ("managed_conversation_runtime_bindings"."base_object_id" is null or "managed_conversation_runtime_bindings"."base_object_id" ~ '^[0-9a-f]{40,64}$')
        and ("managed_conversation_runtime_bindings"."head_object_id" is null or "managed_conversation_runtime_bindings"."head_object_id" ~ '^[0-9a-f]{40,64}$'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_presentation_mode_check" CHECK ("messages"."presentation_mode" is null or "messages"."presentation_mode" in ('expanded','collapsed','status'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_presentation_renderer_check" CHECK ("messages"."presentation_renderer" is null or "messages"."presentation_renderer" in ('message','reasoning_summary'));--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_presentation_mode_check" CHECK ("tool_events"."presentation_mode" is null or "tool_events"."presentation_mode" in ('expanded','collapsed','status'));--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_presentation_renderer_check" CHECK ("tool_events"."presentation_renderer" is null or "tool_events"."presentation_renderer" in ('tool_call','tool_result'));
--> statement-breakpoint
INSERT INTO "conversation_presentation_policy_state" ("id", "revision") VALUES (1, 1);
--> statement-breakpoint
INSERT INTO "conversation_presentation_policy_rules" (
	"source_kind", "source_adapter_version", "item_type", "description",
	"presentation_mode", "renderer_kind"
)
SELECT
	"source_kind", "source_adapter_version", "transcript_type",
	'Owned Conversation presentation for ' || "transcript_type" || '.',
	CASE
		WHEN "transcript_type" IN (
			'user_message','assistant_message','agent_message','subagent_message',
			'message','codex_transcript_user','codex_transcript_agent',
			'codex_transcript_subagent'
		) THEN 'expanded'
		WHEN "transcript_type" IN (
			'function_call','function_call_output','custom_tool_call',
			'custom_tool_call_output','tool_call','tool_result',
			'codex_tool_result','codex_transcript_tool','bash_execution',
			'reasoning_summary','summary_reasoning','thought_summary',
			'summary_thought','reasoning','thought'
		) THEN 'collapsed'
		ELSE 'hidden'
	END,
	CASE
		WHEN "transcript_type" IN (
			'user_message','assistant_message','agent_message','subagent_message',
			'message','codex_transcript_user','codex_transcript_agent',
			'codex_transcript_subagent'
		) THEN 'message'
		WHEN "transcript_type" IN (
			'function_call','custom_tool_call','tool_call','codex_transcript_tool',
			'bash_execution'
		) THEN 'tool_call'
		WHEN "transcript_type" IN (
			'function_call_output','custom_tool_call_output','tool_result',
			'codex_tool_result'
		) THEN 'tool_result'
		WHEN "transcript_type" IN (
			'reasoning_summary','summary_reasoning','thought_summary',
			'summary_thought','reasoning','thought'
		) THEN 'reasoning_summary'
		ELSE 'generic'
	END
FROM "projection_policy_rules";
--> statement-breakpoint
INSERT INTO "conversation_presentation_policy_rules" (
	"source_kind", "source_adapter_version", "item_type", "description",
	"presentation_mode", "renderer_kind"
) VALUES
	('codex', 'codex-transcript-v1', 'approval_request', 'Owner-visible approval request.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'request_approval', 'Owner-visible approval request.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_decision', 'Owner-visible approval decision.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_response', 'Owner-visible approval decision.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_result', 'Owner-visible approval result.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_review_envelope', 'Owner-visible approval review.', 'expanded', 'approval'),
	('codex', 'codex-transcript-v1', 'automatic_approval_decision', 'Owner-visible automatic approval decision.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_tool_result', 'Owner-visible approval tool result.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'approval_helper_conversation', 'Owner-visible approval helper status.', 'status', 'approval'),
	('codex', 'codex-transcript-v1', 'unknown_approval_record', 'Unclassified approval activity remains hidden.', 'hidden', 'generic'),
	('managed_runtime', 'managed-runtime-v1', 'command_approval', 'Interactive command approval.', 'expanded', 'approval'),
	('managed_runtime', 'managed-runtime-v1', 'file_approval', 'Interactive file approval.', 'expanded', 'approval'),
	('managed_runtime', 'managed-runtime-v1', 'permissions_approval', 'Interactive permission approval.', 'expanded', 'approval'),
	('managed_runtime', 'managed-runtime-v1', 'user_input', 'Structured User input request.', 'expanded', 'user_input'),
	('managed_runtime', 'managed-runtime-v1', 'transient_output', 'Provisional AI Client output.', 'expanded', 'message')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "conversation_presentation_policy_rules" (
	"source_kind", "source_adapter_version", "item_type", "description",
	"presentation_mode", "renderer_kind", "enabled"
)
SELECT
	"source_kind", app_server_adapter."version", "item_type",
	"description", "presentation_mode", "renderer_kind", "enabled"
FROM "conversation_presentation_policy_rules"
CROSS JOIN (VALUES
	('codex-app-server-v1'),
	('codex-app-server-conversation-v1')
) AS app_server_adapter("version")
WHERE "source_kind" = 'codex'
	AND "source_adapter_version" = 'codex-transcript-v1'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_bump_conversation_presentation_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		hashtextextended('conversation-presentation-policy', 0)
	);
	UPDATE "conversation_presentation_policy_state"
	SET "revision" = "revision" + 1,
		"updated_at" = now()
	WHERE "id" = 1;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_presentation_policy_rules_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON "conversation_presentation_policy_rules"
FOR EACH STATEMENT
EXECUTE FUNCTION koed_bump_conversation_presentation_policy_revision();
--> statement-breakpoint
DROP TRIGGER IF EXISTS conversation_items_projection_work_notify ON "conversation_items";
--> statement-breakpoint
CREATE TRIGGER conversation_items_projection_work_insert_notify
AFTER INSERT ON "conversation_items"
FOR EACH STATEMENT
EXECUTE FUNCTION notify_koed_projection_work();
--> statement-breakpoint
CREATE TRIGGER conversation_items_projection_work_update_notify
AFTER UPDATE OF "projection_status", "projection_work_class" ON "conversation_items"
FOR EACH ROW
WHEN (
	OLD."projection_status" IS DISTINCT FROM NEW."projection_status"
	OR OLD."projection_work_class" IS DISTINCT FROM NEW."projection_work_class"
)
EXECUTE FUNCTION notify_koed_projection_work();
--> statement-breakpoint
DROP TRIGGER IF EXISTS conversation_projection_outbox_work_notify ON "conversation_projection_processing_outbox";
--> statement-breakpoint
CREATE TRIGGER conversation_projection_outbox_work_insert_notify
AFTER INSERT ON "conversation_projection_processing_outbox"
FOR EACH STATEMENT
EXECUTE FUNCTION notify_koed_projection_work();
--> statement-breakpoint
CREATE TRIGGER conversation_projection_outbox_work_update_notify
AFTER UPDATE OF "dispatched_at" ON "conversation_projection_processing_outbox"
FOR EACH ROW
WHEN (OLD."dispatched_at" IS DISTINCT FROM NEW."dispatched_at")
EXECUTE FUNCTION notify_koed_projection_work();
--> statement-breakpoint
DROP TRIGGER IF EXISTS semantic_memory_rebuild_work_notify ON "semantic_memory_rebuild_jobs";
--> statement-breakpoint
CREATE TRIGGER semantic_memory_rebuild_work_insert_notify
AFTER INSERT ON "semantic_memory_rebuild_jobs"
FOR EACH STATEMENT
EXECUTE FUNCTION notify_koed_projection_work();
--> statement-breakpoint
CREATE TRIGGER semantic_memory_rebuild_work_update_notify
AFTER UPDATE OF "status", "scheduled_after", "processing_lease_until" ON "semantic_memory_rebuild_jobs"
FOR EACH ROW
WHEN (
	OLD."status" IS DISTINCT FROM NEW."status"
	OR OLD."scheduled_after" IS DISTINCT FROM NEW."scheduled_after"
	OR OLD."processing_lease_until" IS DISTINCT FROM NEW."processing_lease_until"
)
EXECUTE FUNCTION notify_koed_projection_work();
