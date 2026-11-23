import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { repositoryTargetFor } from "./repository-project.js";

/** Every check that must agree before a Git Anchor counts as a recorded fact:
 * the Conversation recorded a directory, it still exists on this device, this
 * is the device that recorded the Conversation, the directory existed before
 * the Conversation started, and its Git remote today names the Git Anchor. */
export const INFERRED_GIT_ANCHOR_CHECKS = [
  "recorded-cwd",
  "local-directory",
  "origin-device",
  "directory-birthtime",
  "directory-remote"
] as const;

/** The Git Anchor key this hint proves, or undefined when any check is missing,
 * unavailable or disagrees, or any evidence rejects it. */
export function inferredGitAnchorKey(
  hint: PersonalFolderHint
): string | undefined {
  if (hint.kind !== "repository" || hint.tier === "none" || !hint.repositoryKey)
    return undefined;
  if (hint.reasons.some((reason) => reason.outcome === "rejects"))
    return undefined;
  const agrees = (code: string) =>
    hint.reasons.some(
      (reason) => reason.code === code && reason.outcome === "agrees"
    );
  return INFERRED_GIT_ANCHOR_CHECKS.every(agrees)
    ? hint.repositoryKey
    : undefined;
}

/** Records the Git Anchor a Conversation's evidence proves, through the same
 * versioned correction a User's Add uses, so Git Anchor rules include it.
 * Only a Conversation whose Git Anchor is unresolved and that the User never
 * corrected is touched; a Git Anchor no Project knows is left alone. Failures
 * are skipped, never retried in a loop: the next refresh asks again. */
export async function recordInferredGitAnchors(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  hints: ReadonlyMap<string, readonly PersonalFolderHint[]>,
  check: () => void = () => {}
): Promise<{ recorded: string[]; failed: number }> {
  const recorded: string[] = [];
  let failed = 0;
  if (!api.manageSourceContext) return { recorded, failed };
  for (const [sessionId, sessionHints] of hints) {
    // One clear answer only: two different proven anchors is not a fact.
    const keys = new Set(
      sessionHints.flatMap((hint) => {
        const key = inferredGitAnchorKey(hint);
        return key ? [key] : [];
      })
    );
    if (keys.size !== 1) continue;
    const target = repositoryTargetFor(projects, [...keys][0]!);
    if (!target) continue;
    try {
      check();
      const { context } = await api.manageSourceContext({
        action: "get",
        sessionId
      });
      if (
        context.git.original.state !== "unresolved" ||
        context.git.correction.state !== "original"
      )
        continue;
      check();
      const { preview } = await api.manageSourceContext({
        action: "preview",
        sessionId,
        correction: {
          axis: "git",
          action: "set",
          repository: target.repository,
          expectedVersion: context.git.revision
        }
      });
      if (!preview) continue;
      check();
      await api.manageSourceContext({
        action: "apply",
        sessionId,
        reviewId: preview.reviewId,
        expectedVersion: preview.expectedVersion
      });
      recorded.push(sessionId);
    } catch {
      check();
      failed += 1;
    }
  }
  return { recorded, failed };
}
