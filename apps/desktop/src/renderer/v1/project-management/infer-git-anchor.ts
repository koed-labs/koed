import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { repositoryTargetFor } from "./repository-project.js";

/** Required checks. An assumed-local import leaves recording origin unavailable. */
export const INFERRED_GIT_ANCHOR_CHECKS = [
  "recorded-cwd",
  "local-directory",
  "origin-device",
  "directory-birthtime",
  "directory-remote"
] as const;

/** The Git Anchor key eligible for guarded inference, if any. */
export function inferredGitAnchorKey(
  hint: PersonalFolderHint
): string | undefined {
  const provenance = hint.recordingDeviceProvenance;
  if (
    hint.kind !== "repository" ||
    hint.tier === "none" ||
    !hint.repositoryKey ||
    (provenance !== "recording-device" &&
      provenance !== "assumed-local-import") ||
    hint.gitInferenceEligibility !== true ||
    hint.gitRevision !== 1
  )
    return undefined;
  if (hint.reasons.some((reason) => reason.outcome === "rejects"))
    return undefined;
  const matches = (code: string) => {
    const outcome =
      code === "origin-device" && provenance === "assumed-local-import"
        ? "unavailable"
        : "agrees";
    return hint.reasons.some(
      (reason) => reason.code === code && reason.outcome === outcome
    );
  };
  return INFERRED_GIT_ANCHOR_CHECKS.every(matches)
    ? hint.repositoryKey
    : undefined;
}

/** Records an eligible inferred Git Anchor through a guarded, versioned
 * correction so Git Anchor rules include it.
 * Only a Conversation whose Git Anchor is unresolved and that the User never
 * corrected is touched; a Git Anchor no Project knows is left alone. Failures
 * are skipped, never retried in a loop: the next refresh asks again. */
export async function recordInferredGitAnchors(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  hints: ReadonlyMap<string, readonly PersonalFolderHint[]>,
  scopeKey?: string,
  check: () => void = () => {}
): Promise<{ recorded: string[]; failed: number }> {
  const recorded: string[] = [];
  let failed = 0;
  if (!api.manageSourceContext) return { recorded, failed };
  for (const [sessionId, sessionHints] of hints) {
    const candidates = sessionHints.filter(
      (hint) => hint.sessionId === sessionId && hint.kind === "repository"
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    const key = inferredGitAnchorKey(candidate);
    const version = candidate.gitRevision;
    const inferenceIntent = candidate.recordingDeviceProvenance;
    if (
      !key ||
      version === undefined ||
      (inferenceIntent !== "recording-device" &&
        inferenceIntent !== "assumed-local-import")
    )
      continue;
    if (inferenceIntent === "assumed-local-import" && !scopeKey) continue;
    const scope =
      inferenceIntent === "assumed-local-import"
        ? { expectedScopeKey: scopeKey }
        : {};
    const target = repositoryTargetFor(projects, key);
    if (!target) continue;
    try {
      check();
      const { context } = await api.manageSourceContext({
        action: "get",
        sessionId,
        ...scope
      });
      const signedMissingHistory =
        inferenceIntent === "assumed-local-import" &&
        context.sync?.availability === "available" &&
        context.sync.git.state === "available" &&
        context.sync.git.frontier.length === 1 &&
        context.sync.folder.state !== "conflict";
      if (
        context.git.original.state !== "unresolved" ||
        (context.git.original.reason !== "historical_unresolved" &&
          !(
            context.git.original.reason === "unreliable" && signedMissingHistory
          )) ||
        context.git.correction.state !== "original" ||
        context.git.revision !== version
      )
        continue;
      check();
      const { preview } = await api.manageSourceContext({
        action: "preview",
        sessionId,
        ...scope,
        correction: {
          axis: "git",
          action: "set",
          repository: target.repository,
          expectedVersion: version,
          inferenceIntent
        }
      });
      if (
        preview?.inferenceIntent !== inferenceIntent ||
        preview.expectedVersion !== version
      )
        continue;
      // The Desktop command rechecks current local evidence before forwarding Apply.
      check();
      await api.manageSourceContext({
        action: "apply",
        sessionId,
        ...scope,
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
