ALTER TABLE "sessions" ADD COLUMN "captured_project_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "automatic_project_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "automatic_project_name" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "automatic_project_path" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "automatic_project_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_name" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_path" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_by_user_id" uuid;--> statement-breakpoint
UPDATE "sessions"
SET
  "captured_project_provenance" = jsonb_build_object(
    'schemaVersion', 1,
    'capturedCwd', "cwd",
    'capturedWorkspaceId', coalesce("metadata" ->> 'workspaceId', "workspace_id"::text),
    'candidates', CASE
      WHEN coalesce(
        nullif("metadata" ->> 'localProjectId', ''),
        nullif("metadata" ->> 'projectId', ''),
        nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
        nullif("metadata" ->> 'projectPath', ''),
        nullif("cwd", ''),
        "workspace_id"::text
      ) IS NULL THEN '[]'::jsonb
      ELSE jsonb_build_array(jsonb_build_object(
        'id', coalesce(
          nullif("metadata" ->> 'localProjectId', ''),
          nullif("metadata" ->> 'projectId', ''),
          nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
          nullif("metadata" ->> 'projectPath', ''),
          nullif("cwd", ''),
          "workspace_id"::text
        ),
        'name', coalesce(
          nullif("metadata" ->> 'projectName', ''),
          nullif("metadata" ->> 'projectPath', ''),
          nullif("cwd", ''),
          nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
          "workspace_id"::text
        ),
        'path', coalesce(nullif("metadata" ->> 'projectPath', ''), nullif("cwd", ''))
      ))
    END,
    'outcome', CASE
      WHEN coalesce(
        nullif("metadata" ->> 'localProjectId', ''),
        nullif("metadata" ->> 'projectId', ''),
        nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
        nullif("metadata" ->> 'projectPath', ''),
        nullif("cwd", ''),
        "workspace_id"::text
      ) IS NULL THEN 'no_signal'
      ELSE 'unambiguous'
    END,
    'backfilled', true
  ),
  "automatic_project_id" = coalesce(
    nullif("metadata" ->> 'localProjectId', ''),
    nullif("metadata" ->> 'projectId', ''),
    nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
    nullif("metadata" ->> 'projectPath', ''),
    nullif("cwd", ''),
    "workspace_id"::text
  ),
  "automatic_project_name" = coalesce(
    nullif("metadata" ->> 'projectName', ''),
    nullif("metadata" ->> 'projectPath', ''),
    nullif("cwd", ''),
    nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
    "workspace_id"::text
  ),
  "automatic_project_path" = coalesce(nullif("metadata" ->> 'projectPath', ''), nullif("cwd", '')),
  "automatic_project_detected_at" = CASE
    WHEN coalesce(
      nullif("metadata" ->> 'localProjectId', ''),
      nullif("metadata" ->> 'projectId', ''),
      nullif(nullif("metadata" ->> 'workspaceId', ''), 'default'),
      nullif("metadata" ->> 'projectPath', ''),
      nullif("cwd", ''),
      "workspace_id"::text
    ) IS NULL THEN NULL
    ELSE "created_at"
  END;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_override_by_user_id_users_id_fk" FOREIGN KEY ("project_override_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_owner_effective_project_idx" ON "sessions" USING btree ("owner_user_id","project_override_id","automatic_project_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_automatic_project_shape_check" CHECK (("sessions"."automatic_project_id" is null and "sessions"."automatic_project_name" is null and "sessions"."automatic_project_path" is null and "sessions"."automatic_project_detected_at" is null)
        or ("sessions"."automatic_project_id" is not null and "sessions"."automatic_project_name" is not null and "sessions"."automatic_project_detected_at" is not null));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_override_shape_check" CHECK (("sessions"."project_override_id" is null and "sessions"."project_override_name" is null and "sessions"."project_override_path" is null and "sessions"."project_override_at" is null and "sessions"."project_override_by_user_id" is null)
        or ("sessions"."project_override_id" is not null and "sessions"."project_override_name" is not null and "sessions"."project_override_at" is not null and "sessions"."project_override_by_user_id" is not null));