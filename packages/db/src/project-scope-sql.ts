const identitySql = (alias: string) =>
  `coalesce(${alias}.repository_override_identity, ${alias}.repository_automatic_identity)`;
export const effectiveProjectIdSql = (alias: string) =>
  `repository_scope_id(${identitySql(alias)})`;

// Keep these projections aligned with projectFromRepositoryIdentity. Legacy
// columns are capture/display hints; only repository assignment selects a Project.
export const effectiveProjectNameSql = (alias: string): string => `
  case when ${effectiveProjectIdSql(alias)} is null then 'Unresolved history' else coalesce(
    case when ${alias}.project_override_id = ${effectiveProjectIdSql(alias)} then ${alias}.project_override_name end,
    ${identitySql(alias)}->>'anchorDisplay',
    case when repository_scope_matches(${alias}.repository_automatic_identity, ${effectiveProjectIdSql(alias)}) then ${alias}.automatic_project_name end,
    'Project') end
`;
export const effectiveProjectPathSql = (alias: string): string => `
  case when ${effectiveProjectIdSql(alias)} is null or ${identitySql(alias)}->>'kind' = 'local_project'
    then null else coalesce(${identitySql(alias)}->>'root',
      case when repository_scope_matches(${alias}.repository_automatic_identity, ${effectiveProjectIdSql(alias)}) then ${alias}.automatic_project_path end) end
`;
