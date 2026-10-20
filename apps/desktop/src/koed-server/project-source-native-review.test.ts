import { describe, expect, it, vi } from "vitest";
import { reviewProjectSourceRemoval } from "./project-source-native-review.js";

const id = (last: string) =>
  `00000000-0000-4000-8000-${last.padStart(12, "0")}`;
const projectId = id("1");
const sourceId = id("2");
const batchId = id("3");
const actionGrantId = id("4");
const shareGrantId = id("5");
const review = {
  title: "Freeze Share Grant",
  description: "Freeze the exact grant",
  details: [{ label: "Grant", value: shareGrantId }],
  consequence: "Sharing will stop."
};
const prepared = {
  reservation: {
    sourceId,
    batchId,
    actionGrantId,
    shareGrantId,
    backendId: "backend-a",
    reviewedGrantVersion: 7
  },
  authorityKey: "owner-profile",
  ownerId: id("6")
};
const result = {
  batchId,
  state: "freezing" as const,
  complete: false,
  retryable: true,
  pendingFreezeCount: 1,
  pendingReviews: [],
  cancellationPending: false
};
const setup = () => ({
  projectId,
  sourceId,
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
  advance: vi.fn(async () => result)
});

describe("Project Source Native review", () => {
  it("shows the exact stored review and advances only after device confirmation", async () => {
    const input = setup();
    expect(await reviewProjectSourceRemoval(input)).toEqual(result);
    expect(input.showReview).toHaveBeenCalledWith(review);
    expect(input.confirmGrant).toHaveBeenCalledWith("approve");
    expect(input.prepare).toHaveBeenCalledTimes(2);
    expect(input.advance).toHaveBeenCalledTimes(1);
  });
  it("passes a declined OS decision to the device broker and advances cancellation", async () => {
    const input = setup();
    input.showReview.mockResolvedValue(false);
    await reviewProjectSourceRemoval(input);
    expect(input.confirmGrant).toHaveBeenCalledWith("cancel");
    expect(input.advance).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong device", "ordinary session", "API token"])(
    "fails closed when %s cannot read the enrolled-device grant",
    async () => {
      const input = setup();
      input.awaitGrant.mockRejectedValue(new Error("permission_denied"));
      await expect(reviewProjectSourceRemoval(input)).rejects.toThrow(
        "permission_denied"
      );
      expect(input.showReview).not.toHaveBeenCalled();
      expect(input.advance).not.toHaveBeenCalled();
    }
  );
  it("rejects a changed grant version after the OS dialog", async () => {
    const input = setup();
    input.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce({
      ...prepared,
      reservation: { ...prepared.reservation, reviewedGrantVersion: 8 }
    });
    await expect(reviewProjectSourceRemoval(input)).rejects.toThrow(
      "reservation changed"
    );
    expect(input.confirmGrant).not.toHaveBeenCalled();
    expect(input.advance).not.toHaveBeenCalled();
  });
  it("rejects a profile change and a decision that was not acknowledged", async () => {
    const changed = setup();
    changed.assertAuthority.mockRejectedValue(new Error("profile changed"));
    await expect(reviewProjectSourceRemoval(changed)).rejects.toThrow(
      "profile changed"
    );
    expect(changed.confirmGrant).not.toHaveBeenCalled();
    const unacknowledged = setup();
    unacknowledged.confirmGrant.mockResolvedValue({
      actionGrant: { id: actionGrantId },
      approvalTier: "native_review",
      state: "review_required",
      review
    });
    await expect(reviewProjectSourceRemoval(unacknowledged)).rejects.toThrow(
      "not acknowledged"
    );
    expect(unacknowledged.advance).not.toHaveBeenCalled();
  });
});
