-- Repository context narrows authorized rows; it never grants access.
CREATE FUNCTION repository_scope_matches(identity jsonb, scope text)
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
    identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project')
    AND identity ->> 'kind' = target ->> 'kind'
    AND identity ->> 'key' IS NOT NULL
    AND identity ->> 'key' = target ->> 'key'
    AND (identity ->> 'kind' = 'portable_repository'
      OR identity ->> 'originatingDeviceId' = target ->> 'device'), false);
END;
$$;
