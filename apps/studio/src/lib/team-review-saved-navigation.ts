type TeamReviewSavedNavigationInput = Readonly<{
  pathname: string;
  search: string;
  requestId?: string | null;
  teamId?: string | null;
  reviewVersion: number;
}>;

/** Return the updated current URL only when this scoped link tracks review versions. */
export function teamReviewSavedHref({
  pathname,
  search,
  requestId,
  teamId,
  reviewVersion
}: TeamReviewSavedNavigationInput): string | null {
  if (!requestId || !teamId || !search.includes("teamReviewVersion="))
    return null;

  const params = new URLSearchParams(search);
  if (params.get("teamReviewVersion") === String(reviewVersion)) return null;
  params.set("teamReviewVersion", String(reviewVersion));
  return `${pathname}?${params.toString()}`;
}

/** Keep the owner-authorized request and review versions in the scoped chat URL. */
export function teamAgentRequestContextHref(input: {
  pathname: string;
  search: string;
  requestId: string;
  teamId: string;
  requestVersion: number;
  reviewVersion: number;
}): string | null {
  if (
    !input.requestId ||
    !input.teamId ||
    !Number.isSafeInteger(input.requestVersion) ||
    input.requestVersion < 1 ||
    !Number.isSafeInteger(input.reviewVersion) ||
    input.reviewVersion < 1
  )
    return null;
  const params = new URLSearchParams(input.search);
  params.set("teamRequest", input.requestId);
  params.set("teamRequestTeam", input.teamId);
  params.set("teamRequestVersion", String(input.requestVersion));
  params.set("teamReviewVersion", String(input.reviewVersion));
  const query = params.toString();
  return input.search.replace(/^\?/u, "") === query
    ? null
    : `${input.pathname}?${query}`;
}
