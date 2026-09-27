import type pg from "pg";

export type PublishedPersonalAgentRoleTemplate = Readonly<{
  id: string;
  version: number;
  title: string;
  role: string;
  soulInstructions: string;
  contentSha256: string;
}>;

export function validateTemplate(
  metadata: unknown,
  soulInstructions: string
): PublishedPersonalAgentRoleTemplate;
export function loadTemplate(
  directory: string
): Promise<PublishedPersonalAgentRoleTemplate>;
export function publishTemplate(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  template: PublishedPersonalAgentRoleTemplate
): Promise<{ id: string; version: number }>;
export function publishTemplates(
  pool: Pick<pg.Pool, "connect">,
  templates: readonly PublishedPersonalAgentRoleTemplate[]
): Promise<Array<{ id: string; version: number }>>;
