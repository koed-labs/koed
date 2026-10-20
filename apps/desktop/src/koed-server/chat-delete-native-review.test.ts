import { describe, expect, it, vi } from "vitest";
import { reviewChatDeletion } from "./chat-delete-native-review.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = uuid(1),
  batchId = uuid(2),
  actionGrantId = uuid(3);
const prepared = {
  reservation: {
    sessionId,
    batchId,
    actionGrantId,
    backendId: uuid(4),
    shareGrantId: uuid(5),
    reviewedGrantVersion: 7
  },
  authorityKey: "local-owner-profile",
  ownerId: uuid(6)
};
const review = {
  title: "Freeze sharing",
  description: "Freeze this chat's grant",
  details: [{ label: "Grant", value: uuid(5) }],
  consequence: "Sharing stops."
};
const setup = () => ({
  sessionId,
  batchId,
  actionGrantId,
  prepare: vi.fn(async () => prepared),
  assertAuthority: vi.fn(async () => {}),
  awaitGrant: vi.fn(async () => ({
    actionGrant: { id: actionGrantId },
    approvalTier: "native_review",
    state: "review_required",
    review
  })),
  showReview: vi.fn(async () => true),
  confirmGrant: vi.fn(async (decision: "approve" | "cancel") => ({
    actionGrant: { id: actionGrantId },
    approvalTier: "native_review",
    state: decision === "approve" ? "approved" : "canceled",
    review
  })),
  advance: vi.fn(async () => ({ batchId, complete: true }))
});

describe("chat deletion Native review", () => {
  it("confirms the exact persisted reservation after the OS dialog", async () => {
    const input = setup();
    await reviewChatDeletion(input);
    expect(input.prepare).toHaveBeenCalledTimes(2);
    expect(input.showReview).toHaveBeenCalledWith(review);
    expect(input.confirmGrant).toHaveBeenCalledWith("approve");
    expect(input.advance).toHaveBeenCalledTimes(1);
  });
  it("fails closed if grant version or owner profile changes", async () => {
    const changed = setup();
    changed.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce({
      ...prepared,
      reservation: { ...prepared.reservation, reviewedGrantVersion: 8 }
    });
    await expect(reviewChatDeletion(changed)).rejects.toThrow(
      "reservation changed"
    );
    expect(changed.confirmGrant).not.toHaveBeenCalled();
    const profile = setup();
    profile.assertAuthority.mockRejectedValue(new Error("profile changed"));
    await expect(reviewChatDeletion(profile)).rejects.toThrow(
      "profile changed"
    );
    expect(profile.confirmGrant).not.toHaveBeenCalled();
  });
  it("sends a declined decision to the device broker", async () => {
    const input = setup();
    input.showReview.mockResolvedValue(false);
    await reviewChatDeletion(input);
    expect(input.confirmGrant).toHaveBeenCalledWith("cancel");
  });
  it("never opens a dialog without the enrolled-device grant", async () => {
    const input = setup();
    input.awaitGrant.mockRejectedValue(new Error("permission_denied"));
    await expect(reviewChatDeletion(input)).rejects.toThrow(
      "permission_denied"
    );
    expect(input.showReview).not.toHaveBeenCalled();
  });
});
