import type pg from "pg";

/** Only staged migration rehearsal can observe the old schema. Server startup
 * requires every migration before accepting a client request. */
export const personalModelSchemaInstalled = async (
  client: Pick<pg.Pool, "query">
) => {
  const result = await client.query<{ installed: boolean }>(
    "select to_regclass('public.personal_capture_target_routes') is not null installed"
  );
  return result.rows[0]?.installed === true;
};
export const personalLegacyWriteRetired = () =>
  Object.assign(
    new Error(
      "This Project assignment operation is retired. Use Project inclusion controls or an explicit source-context correction."
    ),
    {
      statusCode: 410,
      code: "personal_legacy_write_retired"
    }
  );
export const assertPersonalLegacyWriteSupported = async (
  client: Pick<pg.Pool, "query">
) => {
  if (await personalModelSchemaInstalled(client))
    throw personalLegacyWriteRetired();
};
