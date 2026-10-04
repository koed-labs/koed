/** Loads the same-origin Studio write token used by local gateway routes. */
export async function loadStudioCsrfToken(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  validateResponse?: (response: Response) => Promise<unknown>
): Promise<string> {
  const response = await fetcher("/studio-api/github/session", {
    credentials: "include",
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal
  });
  let payload: unknown;
  if (validateResponse) {
    payload = await validateResponse(response);
  } else if (!response.ok) {
    throw new Error("Studio session is unavailable.");
  } else {
    payload = await response.json().catch(() => null);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("csrfToken" in payload) ||
    typeof payload.csrfToken !== "string" ||
    !payload.csrfToken.trim()
  ) {
    throw new Error("Studio session is unavailable. Refresh and try again.");
  }
  return payload.csrfToken;
}
