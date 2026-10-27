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
