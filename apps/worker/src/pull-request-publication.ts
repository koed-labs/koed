import type {
  PullRequestFinding,
  PullRequestFrozenReview,
  PullRequestReviewRecord
} from "@koed/shared/pull-requests";
export type PullRequestChangedFile = {
  path: string;
  patch: string | null;
  patchTruncated?: boolean;
};
const fail = (code: string) => Object.assign(new Error(code), { name: code });
export const assertPullRequestPublicationScope = (
  review: PullRequestReviewRecord,
  frozen: PullRequestFrozenReview,
  observed: {
    accountId: string;
    accountLogin: string;
    repositoryId: string;
    baseSha: string;
    headSha: string;
    state: string;
    author: string;
    draft?: boolean;
    merged?: boolean;
  },
  generation: number
) => {
  if (
    review.id !== frozen.reviewId ||
    review.account.id !== frozen.accountId ||
    observed.accountId !== review.account.id ||
    observed.accountLogin.toLowerCase() !==
      review.account.login.toLowerCase() ||
    observed.repositoryId !== review.repository.id ||
    generation !== review.connectionGeneration ||
    generation !== frozen.connectionGeneration
  )
    throw fail("PullRequestPublicationScopeChanged");
  if (
    observed.headSha !== review.expectedHeadSha ||
    observed.baseSha !== review.expectedBaseSha ||
    frozen.headSha !== observed.headSha ||
    frozen.baseSha !== observed.baseSha
  )
    throw fail("PullRequestReviewOutdated");
  if (observed.state !== "open" || observed.merged)
    throw fail("PullRequestPublicationUnavailable");
  if (
    frozen.event !== "COMMENT" &&
    observed.author.toLowerCase() === observed.accountLogin.toLowerCase()
  )
    throw fail("PullRequestSelfApprovalUnavailable");
};
export const changedLines = (patch: string) => {
  const left = new Set<number>(),
    right = new Set<number>();
  let old = 0,
    next = 0,
    inhunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inhunk = true;
      continue;
    }
    if (!inhunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      right.add(next++);
    } else if (line.startsWith("-")) {
      left.add(old++);
    } else if (line.startsWith(" ")) {
      left.add(old++);
      right.add(next++);
    } else {
      inhunk = false;
    }
  }
  return { LEFT: left, RIGHT: right };
};
export const validatePullRequestInlineFindings = (
  findings: readonly PullRequestFinding[],
  files: readonly PullRequestChangedFile[]
) => {
  const indexes = new Map(
    files
      .filter((file) => file.patch && !file.patchTruncated)
      .map((file) => [file.path, changedLines(file.patch!)])
  );
  return findings.map((finding) => {
    if (finding.line === null || finding.side === null)
      throw fail("PullRequestInlineAnchorRequired");
    if (
      finding.path.startsWith("/") ||
      finding.path.split("/").some((part) => part === ".." || part === ".")
    )
      throw fail("PullRequestInlineAnchorInvalid");
    if (!indexes.get(finding.path)?.[finding.side].has(finding.line))
      throw fail("PullRequestInlineAnchorInvalid");
    return {
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: finding.body
    };
  });
};
