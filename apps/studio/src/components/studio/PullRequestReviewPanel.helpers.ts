export function pullRequestReviewMatchesLatest(
  expected: { baseSha: string; headSha: string },
  latest: { baseSha: string; headSha: string }
) {
  return (
    expected.baseSha === latest.baseSha && expected.headSha === latest.headSha
  );
}
