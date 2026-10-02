import { parsePullRequestReviewOutput } from "@koed/shared/pull-requests";
import { stripPersonalMemoryAttributionFooter } from "@koed/shared/personal-memory-attribution";
import {
  validatePullRequestInlineFindings,
  type PullRequestChangedFile
} from "./pull-request-publication.js";

export const pullRequestReviewOutput = (text: string, diff: string) => {
  const output = parsePullRequestReviewOutput(text);
  if (!output) {
    const body = stripPersonalMemoryAttributionFooter(text, { mode: "final" });
    return {
      body:
        body.length <= 65_536
          ? body
          : `${body.slice(0, 65_000)}\n\n[Draft shortened. The complete reply remains in the private chat.]`,
      findings: []
    };
  }
  const files: PullRequestChangedFile[] = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const next = /^\+\+\+ b\/(.+)$/m.exec(section);
    const previous = /^--- a\/(.+)$/m.exec(section);
    const path = next?.[1] ?? previous?.[1];
    if (path)
      files.push({
        path,
        patch: section,
        patchTruncated: section.includes("[Diff truncated;")
      });
  }
  const findings = output.findings
    .map((finding) => ({
      ...finding,
      body: stripPersonalMemoryAttributionFooter(finding.body, {
        mode: "final"
      })
    }))
    .filter((finding) => {
      if (!finding.body.trim()) return false;
      try {
        validatePullRequestInlineFindings([finding], files);
        return true;
      } catch {
        return false;
      }
    });
  return {
    body: stripPersonalMemoryAttributionFooter(output.body, { mode: "final" }),
    findings
  };
};
