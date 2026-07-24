import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadReceiptController } from "./read-receipt.js";

const eligible = {
  atEnd: true,
  documentVisible: true,
  finalUnreadId: "last-unread",
  hasNewer: false,
  lastVisibleId: "last-unread",
  windowFocused: true
};

afterEach(() => vi.useRealTimers());

describe("ReadReceiptController", () => {
  it("requires focus, visibility, newest page, and the final unread row", async () => {
    vi.useFakeTimers();
    const markRead = vi.fn(async () => undefined);
    const controller = new ReadReceiptController({ dwellMs: 100, markRead });

    for (const input of [
      { ...eligible, windowFocused: false },
      { ...eligible, documentVisible: false },
      { ...eligible, atEnd: false },
      { ...eligible, hasNewer: true },
      { ...eligible, lastVisibleId: "earlier" }
    ]) {
      controller.update(input);
      await vi.advanceTimersByTimeAsync(150);
    }

    expect(markRead).not.toHaveBeenCalled();
  });

  it("marks read after an uninterrupted dwell and only once", async () => {
    vi.useFakeTimers();
    const markRead = vi.fn(async () => undefined);
    const controller = new ReadReceiptController({ dwellMs: 100, markRead });
    controller.update(eligible);
    await vi.advanceTimersByTimeAsync(99);
    expect(markRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(markRead).toHaveBeenCalledWith("last-unread");
    controller.update(eligible);
    await vi.advanceTimersByTimeAsync(200);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("cancels the dwell when the row or window stops being visible", async () => {
    vi.useFakeTimers();
    const markRead = vi.fn(async () => undefined);
    const controller = new ReadReceiptController({ dwellMs: 100, markRead });
    controller.update(eligible);
    await vi.advanceTimersByTimeAsync(50);
    controller.update({ ...eligible, documentVisible: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("retries after a failed acknowledgement on a later eligible update", async () => {
    vi.useFakeTimers();
    const markRead = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const controller = new ReadReceiptController({ dwellMs: 10, markRead });
    controller.update(eligible);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();
    controller.update(eligible);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(markRead).toHaveBeenCalledTimes(2);
  });
});
