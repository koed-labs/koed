// A named Project has no filesystem root. Keep the original capture path in
// provenance without presenting it as the effective Project's working folder.
export const effectiveProjectPathSql = (sessionAlias: string): string => `
  case when coalesce(${sessionAlias}.repository_override_identity, ${sessionAlias}.repository_automatic_identity)->>'kind' = 'local_project'
    then null else coalesce(${sessionAlias}.project_override_path, ${sessionAlias}.automatic_project_path) end
`;
