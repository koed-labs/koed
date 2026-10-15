-- Repository context narrows authorized rows; it never grants access.
CREATE OR REPLACE FUNCTION repository_scope_matches(identity jsonb, scope text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE target jsonb;
BEGIN
  IF identity IS NULL OR scope IS NULL OR left(scope, 11) <> 'repository:' THEN
    RETURN false;
  END IF;
  BEGIN
    target := substring(scope FROM 12)::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  RETURN coalesce(
    identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project', 'local_project')
    AND identity ->> 'kind' = target ->> 'kind'
    AND identity ->> 'key' IS NOT NULL
    AND identity ->> 'key' = target ->> 'key'
    AND (identity ->> 'kind' = 'portable_repository'
      OR identity ->> 'originatingDeviceId' = target ->> 'device'), false);
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION repository_scope_id(identity jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project', 'local_project')
    AND identity ->> 'key' IS NOT NULL THEN
      'repository:{"kind":' || to_json(identity ->> 'kind')::text || ',"key":' || to_json(identity ->> 'key')::text || ',"device":' || CASE WHEN identity ->> 'kind' = 'portable_repository' THEN 'null' ELSE to_json(identity ->> 'originatingDeviceId')::text END || '}'
    ELSE null END;
$$;

--> statement-breakpoint
CREATE TABLE "personal_project_routes" (
	"owner_user_id" uuid NOT NULL,
	"source_project_id" text NOT NULL,
	"target_project_id" text NOT NULL,
	"target_name" text NOT NULL,
	"target_path" text,
	"target_identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_routes_owner_user_id_source_project_id_pk" PRIMARY KEY("owner_user_id","source_project_id"),
	CONSTRAINT "personal_project_routes_distinct_check" CHECK ("personal_project_routes"."source_project_id" <> "personal_project_routes"."target_project_id" and "personal_project_routes"."source_project_id" <> 'unassigned')
);
--> statement-breakpoint
ALTER TABLE "personal_project_routes" ADD CONSTRAINT "personal_project_routes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;