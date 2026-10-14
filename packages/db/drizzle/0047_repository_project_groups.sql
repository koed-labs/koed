CREATE FUNCTION repository_scope_id(identity jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project')
    AND identity ->> 'key' IS NOT NULL THEN
      'repository:{"kind":' || to_json(identity ->> 'kind')::text || ',"key":' || to_json(identity ->> 'key')::text || ',"device":' || CASE WHEN identity ->> 'kind' = 'portable_repository' THEN 'null' ELSE to_json(identity ->> 'originatingDeviceId')::text END || '}'
    ELSE null END;
$$;
