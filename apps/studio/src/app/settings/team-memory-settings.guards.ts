import type { OwnedShareItem } from "@koed/shared/collaboration";

export function isHostedTeamMembershipEnabled(status: unknown): boolean {
  return status === "enabled";
}

export function mayApplyTeamMemoryResult(input: {
  active: boolean;
  requestGeneration: number;
  currentGeneration: number;
  requestAuthority: string | null;
  currentAuthority: string | null;
  requestTeamId?: string;
  currentTeamId?: string;
}): boolean {
  return input.active &&
    input.requestGeneration === input.currentGeneration &&
    input.requestAuthority === input.currentAuthority &&
    (input.requestTeamId === undefined || input.requestTeamId === input.currentTeamId);
}

export function pendingShareMatchesDestination(input: {
  shares: readonly OwnedShareItem[];
  logicalMemoryId: string;
  teamId: string;
  workspaceId: string;
}): boolean {
  return input.shares.some((item) => item.kind === "pending" &&
    item.pendingShare.logicalMemoryId === input.logicalMemoryId &&
    item.pendingShare.teamId === input.teamId &&
    item.pendingShare.workspaceId === input.workspaceId &&
    item.pendingShare.state !== "revoked" &&
    item.pendingShare.state !== "activated");
}

export function canStopRetainedUpdates(input: {
  retentionEnabled: boolean;
  updatesActive: boolean;
  shareGrantId: string | null | undefined;
  grantVersion: number | null | undefined;
}): boolean {
  return input.retentionEnabled && input.updatesActive && Boolean(input.shareGrantId) && Boolean(input.grantVersion);
}

export function canCancelUnactivatedPendingShare(input: {
  pendingShareId: string;
  grantId: string | null;
  state: string;
  workspaceAccessState: string;
}): boolean {
  return input.grantId === null &&
    input.state !== "revoked" &&
    input.workspaceAccessState !== "revoked" &&
    Boolean(input.pendingShareId);
}

export function canReviewHostedShare(input: {
  kind: "grant" | "pending";
  grantId: string | null;
  grantVersion: number | null;
  lifecycle?: string;
  pendingState?: string;
  sourceMatches: boolean;
  copyReady: boolean;
  anotherUpdatePending: boolean;
}): boolean {
  if (!input.grantId || !input.grantVersion || !input.sourceMatches || !input.copyReady || input.anotherUpdatePending) return false;
  return input.kind === "grant"
    ? input.lifecycle === "active"
    : input.pendingState === "activated";
}

export function hasAnotherOwnedSharePage(input: {
  nextCursor: string | null;
  pagesRead: number;
  pageLimit: number;
}): boolean {
  return input.nextCursor !== null && input.pagesRead < input.pageLimit;
}

export async function findPendingOwnedShare(input: {
  loadPage: (cursor: string | null) => Promise<{ shares: readonly OwnedShareItem[]; nextCursor: string | null }>;
  isCurrent: () => boolean;
  logicalMemoryId: string;
  teamId: string;
  workspaceId: string;
  pageLimit: number;
}): Promise<{ found: boolean; complete: boolean }> {
  let cursor: string | null = null;
  let pagesRead = 0;
  while (true) {
    const page = await input.loadPage(cursor);
    if (!input.isCurrent()) return { found: false, complete: false };
    pagesRead += 1;
    if (pendingShareMatchesDestination({
      shares: page.shares,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      workspaceId: input.workspaceId
    })) return { found: true, complete: true };
    cursor = page.nextCursor;
    if (!hasAnotherOwnedSharePage({ nextCursor: cursor, pagesRead, pageLimit: input.pageLimit })) {
      return { found: false, complete: cursor === null };
    }
  }
}
