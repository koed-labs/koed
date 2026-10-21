import { z } from "zod";
import {
  crossIdentitySyncDigest,
  sharingSelectionDescriptor,
  personalSelectionConsumerPageSchema,
  gitAnchorSharingReviewPageSchema,
  sharingDestinationReviewSchema,
  sharedMemoryCandidatePreviewSchema,
  type GitAnchorSharingReviewInput,
  type PersonalSelectionConsumerPage,
  type SharedMemoryCandidatePreview,
  type SharingDestinationReview
} from "@koed/shared";
import type { SharingRuleMutationIntent } from "@koed/shared";
import { openOpaqueCursor, sealOpaqueCursor } from "./opaque-cursor.js";

const cursorSchema = z
  .object({
    version: z.literal(1),
    backendId: z.string(),
    ownerUserId: z.uuid(),
    upstreamUserId: z.uuid(),
    intentHash: z.string(),
    destinationHash: z.string(),
    snapshotVersion: z.uuid(),
    cursor: z.uuid()
  })
  .strict();

const completedReviewSchema = cursorSchema
  .omit({ cursor: true })
  .extend({
    changeCursor: z.uuid(),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict();

export class SharingReviewConflict extends Error {}

/** After approval, verify the private selector still matches the approved
 * handoff without requiring an expired observation cursor to become fresh.
 * Publication must separately enumerate and authorize current membership. */
export const validateCompletedGitAnchorRuleCreationIntent = (
  input: Extract<
    SharingRuleMutationIntent,
    { includesFutureConversations: true }
  >,
  deps: {
    backendId: string;
    ownerUserId: string;
    upstreamUserId: string;
    cursorSecret: string;
  }
) => {
  const { completionToken, ...reviewIntent } = input.review;
  const parsed = completedReviewSchema.safeParse(
    openOpaqueCursor({
      secret: deps.cursorSecret,
      prefix: "gsc1",
      domain: "git-anchor-sharing-confirmation",
      cursor: completionToken
    })
  );
  const selector = sharingSelectionDescriptor(input.review.target);
  if (
    !parsed.success ||
    parsed.data.backendId !== deps.backendId ||
    parsed.data.ownerUserId !== deps.ownerUserId ||
    parsed.data.upstreamUserId !== deps.upstreamUserId ||
    parsed.data.intentHash !== crossIdentitySyncDigest(reviewIntent) ||
    parsed.data.snapshotVersion !== input.selectionSnapshotVersion ||
    input.teamId !== input.review.teamId ||
    input.teamWorkspaceId !== input.review.workspaceId ||
    input.maximumFidelity !== input.review.representation ||
    input.includeCuratedMemory ||
    crossIdentitySyncDigest(selector) !==
      crossIdentitySyncDigest(input.selector) ||
    input.completedReviewHash !==
      crossIdentitySyncDigest({
        purpose: "git_anchor_continuous_sharing_review",
        ...parsed.data,
        includesFutureConversations: true
      })
  )
    throw new SharingReviewConflict(
      "The queued rule no longer matches its completed Personal review."
    );
};

export interface SharingSelectionReviewDependencies {
  backendId: string;
  ownerUserId: string;
  upstreamUserId: string;
  cursorSecret: string;
  enumerate(input: {
    target: GitAnchorSharingReviewInput["target"];
    cursor: string | null;
  }): Promise<PersonalSelectionConsumerPage>;
  hasChanges(cursor: string): Promise<boolean>;
  headers(
    page: PersonalSelectionConsumerPage
  ): Promise<Map<string, { title: string; eventCount: number }>>;
  candidate(
    sessionId: string,
    representation: GitAnchorSharingReviewInput["representation"]
  ): Promise<SharedMemoryCandidatePreview | null>;
  destination(): Promise<SharingDestinationReview>;
}

/** Review metadata only. No consent, sync, grant or publication writer is available. */
export const reviewGitAnchorSharing = async (
  input: GitAnchorSharingReviewInput,
  deps: SharingSelectionReviewDependencies
) => {
  const { cursor: encoded, ...intent } = input;
  const intentHash = crossIdentitySyncDigest(intent);
  const prior = encoded
    ? cursorSchema.safeParse(
        openOpaqueCursor({
          secret: deps.cursorSecret,
          prefix: "gsr1",
          domain: "git-anchor-sharing-review",
          cursor: encoded
        })
      )
    : null;
  if (
    encoded &&
    (!prior?.success ||
      prior.data.intentHash !== intentHash ||
      prior.data.backendId !== deps.backendId ||
      prior.data.ownerUserId !== deps.ownerUserId ||
      prior.data.upstreamUserId !== deps.upstreamUserId)
  ) {
    throw new SharingReviewConflict(
      "The review no longer matches its owner, selection or destination. Refresh the review."
    );
  }
  const destination = sharingDestinationReviewSchema.parse(
    await deps.destination()
  );
  if (
    destination.teamId !== input.teamId ||
    destination.workspaceId !== input.workspaceId ||
    destination.representation !== input.representation
  )
    throw new SharingReviewConflict("The reviewed destination changed.");
  const destinationHash = crossIdentitySyncDigest(destination);
  if (prior?.success && prior.data.destinationHash !== destinationHash)
    throw new SharingReviewConflict(
      "Destination policy changed. Refresh the review."
    );
  const page = personalSelectionConsumerPageSchema.parse(
    await deps.enumerate({
      target: input.target,
      cursor: prior?.success ? prior.data.cursor : null
    })
  );
  if (
    page.selection.ownerUserId !== deps.ownerUserId ||
    crossIdentitySyncDigest(page.selection.target) !==
      crossIdentitySyncDigest(input.target) ||
    (prior?.success && prior.data.snapshotVersion !== page.snapshotVersion)
  )
    throw new SharingReviewConflict("The reviewed Personal selection changed.");
  if (
    (page.nextCursor === null) !== (page.changeCursor !== null) ||
    Date.parse(page.expiresAt) <= Date.now()
  )
    throw new SharingReviewConflict(
      "The selection review expired or is incomplete."
    );
  const headers = await deps.headers(page);
  const sources = new Map<string, SharedMemoryCandidatePreview | null>();
  // Bound concurrency: a source read can prepare a substantial local candidate.
  for (const id of new Set(
    page.entries.map((entry) => entry.source.localSessionId)
  )) {
    const header = headers.get(id);
    if (
      !header ||
      (input.representation === "memory_events" && header.eventCount === 0)
    ) {
      sources.set(id, null);
      continue;
    }
    const raw = await deps.candidate(id, input.representation);
    const candidate =
      raw === null ? null : sharedMemoryCandidatePreviewSchema.parse(raw);
    if (
      candidate &&
      (candidate.source.kind !== "captured_session" ||
        candidate.source.sessionId !== id)
    )
      throw new SharingReviewConflict("The reviewed source binding changed.");
    sources.set(id, candidate);
  }
  if (page.changeCursor && (await deps.hasChanges(page.changeCursor)))
    throw new SharingReviewConflict(
      "Personal Memory changed during review. Refresh the complete review."
    );
  const currentDestination = sharingDestinationReviewSchema.parse(
    await deps.destination()
  );
  if (crossIdentitySyncDigest(currentDestination) !== destinationHash)
    throw new SharingReviewConflict(
      "Destination policy changed during review."
    );
  return gitAnchorSharingReviewPageSchema.parse({
    target: input.target,
    destination,
    snapshotVersion: page.snapshotVersion,
    entries: page.entries.map((entry) => {
      const candidate = sources.get(entry.source.localSessionId);
      // This is current eligibility for review, not publication approval.
      const eligible =
        candidate &&
        candidate.mode === "continuous" &&
        candidate.activationRepresentation === input.representation &&
        candidate.itemCount > 0;
      return {
        ...entry,
        title:
          headers.get(entry.source.localSessionId)?.title ??
          "Untitled Conversation",
        readiness: eligible ? "eligible" : "unresolved",
        sourceRevision: eligible ? candidate.sourceRevision : null,
        itemCount: eligible ? candidate.itemCount : null
      };
    }),
    nextCursor: page.nextCursor
      ? sealOpaqueCursor({
          secret: deps.cursorSecret,
          prefix: "gsr1",
          domain: "git-anchor-sharing-review",
          payload: {
            version: 1,
            backendId: deps.backendId,
            ownerUserId: deps.ownerUserId,
            upstreamUserId: deps.upstreamUserId,
            intentHash,
            destinationHash,
            snapshotVersion: page.snapshotVersion,
            cursor: page.nextCursor
          }
        })
      : null,
    complete: page.nextCursor === null,
    completionToken: page.changeCursor
      ? sealOpaqueCursor({
          secret: deps.cursorSecret,
          prefix: "gsc1",
          domain: "git-anchor-sharing-confirmation",
          payload: {
            version: 1,
            backendId: deps.backendId,
            ownerUserId: deps.ownerUserId,
            upstreamUserId: deps.upstreamUserId,
            intentHash,
            destinationHash,
            snapshotVersion: page.snapshotVersion,
            changeCursor: page.changeCursor,
            expiresAt: page.expiresAt
          }
        })
      : null,
    includesFutureConversations: true,
    expiresAt: page.expiresAt
  });
};

/** Resolve an owner-only handoff before native review. This grants no publication
 * authority and does not install a membership baseline or acknowledge progress. */
export const resolveCompletedGitAnchorSharingReview = async (
  input: Omit<GitAnchorSharingReviewInput, "cursor"> & {
    completionToken: string;
  },
  deps: Pick<
    SharingSelectionReviewDependencies,
    | "backendId"
    | "ownerUserId"
    | "upstreamUserId"
    | "cursorSecret"
    | "hasChanges"
    | "destination"
  >
) => {
  const { completionToken, ...intent } = input;
  const parsed = completedReviewSchema.safeParse(
    openOpaqueCursor({
      secret: deps.cursorSecret,
      prefix: "gsc1",
      domain: "git-anchor-sharing-confirmation",
      cursor: completionToken
    })
  );
  if (
    !parsed.success ||
    parsed.data.backendId !== deps.backendId ||
    parsed.data.ownerUserId !== deps.ownerUserId ||
    parsed.data.upstreamUserId !== deps.upstreamUserId ||
    parsed.data.intentHash !== crossIdentitySyncDigest(intent) ||
    Date.parse(parsed.data.expiresAt) <= Date.now()
  )
    throw new SharingReviewConflict(
      "Refresh the complete review for this owner, selection and destination."
    );
  const destination = sharingDestinationReviewSchema.parse(
    await deps.destination()
  );
  if (
    crossIdentitySyncDigest(destination) !== parsed.data.destinationHash ||
    (await deps.hasChanges(parsed.data.changeCursor))
  )
    throw new SharingReviewConflict(
      "The reviewed selection or destination changed. Refresh the complete review."
    );
  // Destination reads and the visibility-safe checkpoint are rechecked at the
  // handoff, rather than treating an old final page as future-member consent.
  const current = sharingDestinationReviewSchema.parse(
    await deps.destination()
  );
  if (
    crossIdentitySyncDigest(current) !== parsed.data.destinationHash ||
    Date.parse(parsed.data.expiresAt) <= Date.now()
  )
    throw new SharingReviewConflict(
      "The completed sharing review expired or changed."
    );
  return {
    reviewHash: crossIdentitySyncDigest({
      purpose: "git_anchor_continuous_sharing_review",
      ...parsed.data,
      includesFutureConversations: true
    }),
    snapshotVersion: parsed.data.snapshotVersion,
    expiresAt: parsed.data.expiresAt,
    destination: current
  };
};
