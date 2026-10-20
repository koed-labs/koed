import { describe, expect, it, vi } from "vitest";
import { reviewChatMove } from "./chat-move-native-review.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = uuid(1),
  batchId = uuid(2),
  actionGrantId = uuid(3);
const reservation = {
  sessionId,
  batchId,
  bindingId: uuid(4),
  commandRequestId: uuid(5),
  oldProjectId: uuid(6),
  oldWorkspaceProjectId: uuid(13),
  oldProjectVersion: 2,
  targetProjectId: uuid(7),
  mappingVersion: 3,
  backendId: "backend-1",
  logicalMemoryId: uuid(8),
  teamId: uuid(9),
  teamWorkspaceId: uuid(10),
  shareGrantId: uuid(11),
  actionGrantId,
  reviewedGrantVersion: 4,
  manifestHash: "a".repeat(64)
};
const prepared = {
  reservation,
  authorityKey: "owner-profile",
  ownerId: uuid(12)
};
const review = {
  title: "Freeze sharing",
  description: "Move this chat to a different Project",
  details: [
    { label: "From", value: uuid(6) },
    { label: "To", value: uuid(7) }
  ],
  consequence: "The existing share grant is frozen."
};
const grant = (state: string, visibleReview = review) => ({
  actionGrant: { id: actionGrantId },
  approvalTier: "native_review",
  state,
  review: visibleReview
});
const setup = () => ({
  sessionId,
  batchId,
  actionGrantId,
  prepare: vi.fn(async () => prepared),
  assertAuthority: vi.fn(async () => {}),
  awaitGrant: vi.fn(async () => grant("review_required")),
  showReview: vi.fn(async () => true),
  confirmGrant: vi.fn(async (decision: "approve" | "cancel") =>
    grant(decision === "approve" ? "approved" : "canceled")
  ),
  advance: vi.fn(async () => ({ sessionId, batchId, pending: true }))
});

describe("chat move trusted Native review", () => {
  it("approves only the matching review and advances the bound operation", async () => {
    const input = setup();
    await reviewChatMove(input);
    expect(input.prepare).toHaveBeenCalledTimes(2);
    expect(input.awaitGrant).toHaveBeenCalledTimes(2);
    expect(input.showReview).toHaveBeenCalledWith(review);
    expect(input.confirmGrant).toHaveBeenCalledExactlyOnceWith("approve");
    expect(input.advance).toHaveBeenCalledTimes(1);
  });

  it("checks every immutable reservation field before confirmation", async () => {
    for (const field of Object.keys(
      reservation
    ) as (keyof typeof reservation)[]) {
      const input = setup();
      input.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce({
        ...prepared,
        reservation: { ...reservation, [field]: "changed" }
      });
      await expect(reviewChatMove(input)).rejects.toThrow(
        "reservation changed"
      );
      expect(input.confirmGrant).not.toHaveBeenCalled();
      expect(input.advance).not.toHaveBeenCalled();
    }
  });

  it("rejects a changed Workspace Project link or version after the dialog", async () => {
    for (const changed of [
      { oldWorkspaceProjectId: uuid(40) },
      { oldProjectVersion: reservation.oldProjectVersion + 1 }
    ]) {
      const input = setup();
      input.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce({
        ...prepared,
        reservation: { ...reservation, ...changed }
      });
      await expect(reviewChatMove(input)).rejects.toThrow(
        "reservation changed"
      );
      expect(input.confirmGrant).not.toHaveBeenCalled();
      expect(input.advance).not.toHaveBeenCalled();
    }
  });

  it("rejects a different operation, owner profile, grant, or changed review text", async () => {
    const operation = setup();
    operation.prepare.mockResolvedValueOnce({
      ...prepared,
      reservation: { ...reservation, batchId: uuid(30) }
    });
    await expect(reviewChatMove(operation)).rejects.toThrow(
      "reservation changed"
    );
    expect(operation.showReview).not.toHaveBeenCalled();

    const profile = setup();
    profile.assertAuthority.mockRejectedValueOnce(new Error("profile changed"));
    await expect(reviewChatMove(profile)).rejects.toThrow("profile changed");
    expect(profile.showReview).not.toHaveBeenCalled();

    const wrongGrant = setup();
    wrongGrant.awaitGrant.mockResolvedValueOnce({
      ...grant("review_required"),
      actionGrant: { id: uuid(31) }
    });
    await expect(reviewChatMove(wrongGrant)).rejects.toThrow("grant changed");
    expect(wrongGrant.showReview).not.toHaveBeenCalled();

    const changedText = setup();
    changedText.awaitGrant
      .mockResolvedValueOnce(grant("review_required"))
      .mockResolvedValueOnce(
        grant("review_required", {
          ...review,
          details: [
            { label: "From", value: uuid(6) },
            { label: "To", value: uuid(32) }
          ]
        })
      );
    await expect(reviewChatMove(changedText)).rejects.toThrow(
      "details changed"
    );
    expect(changedText.confirmGrant).not.toHaveBeenCalled();
  });

  it("sends a canceled decision and reconciles without approving", async () => {
    const input = setup();
    input.showReview.mockResolvedValue(false);
    await reviewChatMove(input);
    expect(input.confirmGrant).toHaveBeenCalledExactlyOnceWith("cancel");
    expect(input.advance).toHaveBeenCalledTimes(1);
  });

  it("never repeats a confirmed or ambiguous approval", async () => {
    const alreadyApproved = setup();
    alreadyApproved.awaitGrant.mockResolvedValueOnce(grant("approved"));
    await reviewChatMove(alreadyApproved);
    expect(alreadyApproved.showReview).not.toHaveBeenCalled();
    expect(alreadyApproved.confirmGrant).not.toHaveBeenCalled();
    expect(alreadyApproved.advance).toHaveBeenCalledTimes(1);

    const ambiguous = setup();
    ambiguous.confirmGrant.mockRejectedValueOnce(
      new Error("uncertain outcome")
    );
    await expect(reviewChatMove(ambiguous)).rejects.toThrow(
      "uncertain outcome"
    );
    expect(ambiguous.confirmGrant).toHaveBeenCalledTimes(1);
    expect(ambiguous.advance).not.toHaveBeenCalled();
  });
});
