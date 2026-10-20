import type pg from "pg";
import {
  personalFolderContextSchema,
  type PersonalFolderReference,
  type PersonalFolderContext
} from "@koed/shared";
import type { ActorContext } from "./types.js";
const assertFolderOwner = (
  actor: ActorContext,
  folder: PersonalFolderReference
) => {
  if (folder.ownerUserId !== actor.userId)
    throw Object.assign(new Error("Folder belongs to another owner"), {
      statusCode: 403
    });
};
export const findPersonalFolderContext = async (
  client: Pick<pg.Pool, "query">,
  actor: ActorContext,
  projectId: string,
  folder: PersonalFolderReference
): Promise<PersonalFolderContext | undefined> => {
  assertFolderOwner(actor, folder);
  const result = await client.query<{ context: unknown }>(
    `
    select facts.fact->'value' as context from sessions s
    cross join lateral (values (s.folder_assignment->'original'),(s.folder_assignment->'correction'->'value')) facts(fact)
    where s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
      and facts.fact->>'state'='known' and facts.fact->'value'->'reference'=$3::jsonb
    union all select folder_context as context from personal_project_rules
    where owner_user_id=$1 and project_id=$2 and target->'folder'=$3::jsonb and folder_context is not null
    limit 1`,
    [actor.userId, projectId, folder]
  );
  return result.rows[0]
    ? personalFolderContextSchema.parse(result.rows[0].context)
    : undefined;
};
