// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  RepositoryReview,
  RepositoryReviewCommand
} from "@koed/shared/repository-review";
import { RepositoryReviewPanel } from "./RepositoryReviewPanel.js";
const localProjectId = `lp_${"1".repeat(32)}`;
const identity = {
  kind: "portable_repository" as const,
  key: "gr_a",
  root: "/fixture",
  branch: "main",
  reason: "origin" as const,
  checkoutId: "checkout_a",
  originatingDeviceId: "pms_a",
  selectedRemote: "origin",
  anchorDisplay: "example/a"
};
const event = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "anchor_change" as const,
  originatingDeviceId: "pms_a",
  checkoutId: "checkout_a",
  originatingRevision: 1,
  previousIdentity: identity,
  targetIdentity: { ...identity, key: "gr_b", anchorDisplay: "example/b" },
  revision: 3,
  status: "pending" as const,
  createdAt: "2026-10-14T00:00:00.000Z"
};
const review: RepositoryReview = {
  id: "22222222-2222-4222-8222-222222222222",
  event,
  options: { includeOverrides: true, includeUnresolved: false },
  count: 2,
  status: "reviewed",
  sessions: [1, 2].map((n) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Session ${n}`,
    cwd: `/fixture/${n}`,
    assignment: {
      state: "recorded" as const,
      version: n,
      automatic: identity,
      override:
        n === 2
          ? { ...identity, key: "gr_override", anchorDisplay: "User override" }
          : null,
      effective: identity
    }
  }))
};
const button = (container: HTMLDivElement, text: string) =>
  [...container.querySelectorAll("button")].find(
    (el) => el.textContent === text || el.getAttribute("aria-label") === text
  )!;
it("previews immutable source assignments and dismisses without offering a move", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  const changed = vi.fn().mockResolvedValue(undefined);
  const onReview = vi.fn(async (input: RepositoryReviewCommand) =>
    input.operation === "list"
      ? { events: [event] }
      : input.operation === "preview"
        ? { review }
        : { review: { ...review, status: "dismissed" as const } }
  );
  try {
    await act(async () =>
      root.render(
        <RepositoryReviewPanel
          localProjectId={localProjectId}
          onReview={onReview}
          onChanged={changed}
        />
      )
    );
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    await act(async () => button(container, "Preview Conversations").click());
    expect(onReview).toHaveBeenLastCalledWith({
      operation: "preview",
      localProjectId,
      eventId: event.id,
      options: { includeOverrides: true, includeUnresolved: false }
    });
    expect(container.textContent).toContain("2 Conversations in this review");
    expect(container.textContent).toContain("Assignment version 2");
    expect(container.textContent).toContain(
      "Current source correction: User override"
    );
    expect(
      container.querySelector('[aria-label="Reviewed Conversations"] input')
    ).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((node) =>
        node.textContent?.includes("Move")
      )
    ).toBe(false);
    await act(async () => button(container, "Dismiss").click());
    expect(onReview).toHaveBeenLastCalledWith({
      operation: "dismiss",
      localProjectId,
      reviewId: review.id,
      expectedRevision: 3
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "Recorded source context is unchanged"
    );
  } finally {
    await act(async () => root.unmount());
  }
});
it("clears a stale review after dismissal fails", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  const onReview = vi.fn(async (input: RepositoryReviewCommand) =>
    input.operation === "list" ? { events: [event] } : { review }
  );
  try {
    await act(async () =>
      root.render(
        <RepositoryReviewPanel
          localProjectId={localProjectId}
          onReview={onReview}
        />
      )
    );
    await act(async () => button(container, "Preview Conversations").click());
    onReview.mockRejectedValueOnce(
      new Error("The repository review changed. Inspect it again.")
    );
    await act(async () => button(container, "Dismiss").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Inspect it again"
    );
    expect(
      container.querySelector('[aria-label="Reviewed Conversations"]')
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
