import type pg from "pg";

type TeamLifecycleAction =
  | "team.leave"
  | "team.member.disable"
  | "team.workspace.access_update";

interface VerifiedFreezeScope {
  transactionClient: pg.PoolClient;
  action: TeamLifecycleAction;
  outerActionGrantId: string;
  outerRequestId: string;
  outerRequestHash: string;
  approvalTier: "native_review" | "step_up";
  actorUserId: string;
  teamId: string;
  targetUserId: string;
  targetVersion: number;
  teamWorkspaceId: string | null;
  shareGrantId: string;
  expectedGrantVersion: number;
}

declare const teamFreezeAuthorityBrand: unique symbol;
export type TeamLifecycleFreezeAuthority = {
  readonly [teamFreezeAuthorityBrand]: true;
};

const authorities = new WeakMap<
  object,
  VerifiedFreezeScope & { used: boolean }
>();

// This module is internal to the backend. Only the high-risk execution scope
// issues a token after it has verified the outer one-use Action Grant and the
// Team repository has locked the exact target and derived its grant set.
export const issueTeamLifecycleFreezeAuthority = (
  scope: VerifiedFreezeScope
): TeamLifecycleFreezeAuthority => {
  const token = Object.freeze({}) as TeamLifecycleFreezeAuthority;
  authorities.set(token, { ...scope, used: false });
  return token;
};

export const consumeTeamLifecycleFreezeAuthority = (
  token: unknown,
  input: {
    transactionClient: pg.PoolClient;
    actorUserId: string;
    shareGrantId: string;
    expectedGrantVersion: number;
  }
): VerifiedFreezeScope | null => {
  if (typeof token !== "object" || token === null) return null;
  const scope = authorities.get(token);
  if (
    !scope ||
    scope.used ||
    scope.transactionClient !== input.transactionClient ||
    scope.actorUserId !== input.actorUserId ||
    scope.shareGrantId !== input.shareGrantId ||
    scope.expectedGrantVersion !== input.expectedGrantVersion
  )
    return null;
  scope.used = true;
  return scope;
};
