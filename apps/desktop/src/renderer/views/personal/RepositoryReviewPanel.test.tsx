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
    (el) => el.textContent === text
  )!;
it("shows fixed versions and replaced overrides, applies only selected ids, and reloads groups", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const changed = vi.fn().mockResolvedValue(undefined);
  const onReview = vi.fn(async (input: RepositoryReviewCommand) =>
    input.operation === "list"
      ? { events: [event] }
      : input.operation === "preview"
        ? { review }
        : { review: { ...review, status: "applied" as const } }
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
      button(container, "Review repository changes").click()
    );
    expect(container.textContent).toContain("example/a");
    expect(container.textContent).toContain("example/b");
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    await act(async () => button(container, "Prepare fixed review").click());
    expect(onReview).toHaveBeenLastCalledWith({
      operation: "preview",
      localProjectId,
      eventId: event.id,
      options: { includeOverrides: true, includeUnresolved: false }
    });
    expect(container.textContent).toContain("2 sessions in this fixed review");
    expect(container.textContent).toContain("Assignment version 2");
    expect(container.textContent).toContain(
      "Manual override to replace: User override"
    );
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      '[aria-label="Reviewed sessions"] input'
    );
    await act(async () => checkboxes[1]!.click());
    await act(async () =>
      button(container, "Apply to 1 selected sessions").click()
    );
    expect(onReview).toHaveBeenLastCalledWith({
      operation: "apply",
      localProjectId,
      reviewId: review.id,
      expectedRevision: 3,
      sessionIds: [review.sessions[0]!.id]
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("accepted set was reassigned");
  } finally {
    await act(async () => root.unmount());
  }
});
it("allows dismissal without applying and clears a stale review on failure", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
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
        />
      )
    );
    await act(async () =>
      button(container, "Review repository changes").click()
    );
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click()
    );
    await act(async () => button(container, "Prepare fixed review").click());
    await act(async () =>
      button(container, "Dismiss without reassignment").click()
    );
    expect(onReview).toHaveBeenLastCalledWith({
      operation: "dismiss",
      localProjectId,
      reviewId: review.id,
      expectedRevision: 3
    });
    expect(
      onReview.mock.calls.some(([input]) => input.operation === "apply")
    ).toBe(false);
    expect(container.textContent).toContain("Assignments were unchanged");
    await act(async () =>
      button(container, "Review repository changes").click()
    );
    await act(async () => button(container, "Prepare fixed review").click());
    onReview.mockRejectedValueOnce(
      new Error("The session changed. Nothing was reassigned.")
    );
    await act(async () =>
      button(container, "Apply to 2 selected sessions").click()
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Nothing was reassigned"
    );
    expect(
      container.querySelector('[aria-label="Reviewed sessions"]')
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
