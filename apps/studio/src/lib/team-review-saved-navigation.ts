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
