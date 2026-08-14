const normalizedOrigin = (value, label) => {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) origin.`);
  }
  return url.origin;
};

const authorizationHeaders = (
  { desktopAuthorization, browserCookie },
  requestOrigin
) => {
  if (desktopAuthorization) {
    return { authorization: desktopAuthorization };
  }
  if (browserCookie) {
    return { cookie: browserCookie, origin: requestOrigin };
  }
  throw new Error("Joining-device local authentication is required.");
};

const jsonResponse = async (response, label) => {
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== "object") {
    throw new Error(`${label} failed (${response.status}).`);
  }
  return value;
};

export const reconcileJoiningDeviceDatabase = async (input) => {
  const authorityOrigin = normalizedOrigin(
    input.authorityControlUrl,
    "Authority control URL"
  );
  const joiningOrigin = normalizedOrigin(
    input.joiningControlUrl,
    "Joining control URL"
  );
  if (authorityOrigin === joiningOrigin) {
    throw new Error(
      "Two-database pairing validation requires distinct local API origins."
    );
  }
  const auth = authorizationHeaders(input, joiningOrigin);
  const reconciliation = await jsonResponse(
    await input.fetch(
      `${joiningOrigin}/v1/personal-device-sync/local-group-reconciliation`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...auth
        },
        body: JSON.stringify(input.localGroupReconciliation)
      }
    ),
    "Joining-device local group reconciliation"
  );
  if (
    typeof reconciliation.local_user_id !== "string" ||
    !reconciliation.group ||
    typeof reconciliation.group !== "object"
  ) {
    throw new Error(
      "Joining-device local group reconciliation returned an invalid result."
    );
  }
  const group = await jsonResponse(
    await input.fetch(
      `${joiningOrigin}/v1/personal-device-sync/groups/${encodeURIComponent(input.groupId)}`,
      {
        headers: {
          accept: "application/json",
          ...auth
        }
      }
    ),
    "Joining-device local group verification"
  );
  if (
    !group.group ||
    typeof group.group !== "object" ||
    group.group.group_id !== input.groupId
  ) {
    throw new Error(
      "Joining-device local database did not retain the Personal Device Group."
    );
  }
  return {
    localUserId: reconciliation.local_user_id,
    group: group.group
  };
};
