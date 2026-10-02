export type PushPanelProposal = {
  id: string;
  diffDigest: string;
};

export const pullRequestPushConfirmationKey = (
  proposal: PushPanelProposal | null
) => (proposal ? `${proposal.id}:${proposal.diffDigest}` : null);

export const canConfirmPullRequestPush = (input: {
  proposal: PushPanelProposal | null;
  confirmed: boolean;
  busy: boolean;
  pendingOperationId: string | null;
  uncertainOperationId: string | null;
}) =>
  Boolean(
    input.proposal &&
    input.confirmed &&
    !input.busy &&
    !input.pendingOperationId &&
    !input.uncertainOperationId
  );
