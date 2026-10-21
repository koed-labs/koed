import { describe, expect, it, vi } from "vitest";
import {
  loadUnseenProjectActivity,
  type ProjectActivity
} from "./project-catch-up.js";

const at = "2026-10-20T10:00:00.000Z";
const event = (
  cursor: string,
  kind: ProjectActivity["kind"]
): ProjectActivity => ({
  cursor,
  actorUserId: "00000000-0000-4000-8000-000000000001",
  kind,
  ref: "00000000-0000-4000-8000-000000000002",
  ...(kind === "source_ready" || kind === "source_failed"
    ? {
        sourceOutcome: {
          sourceId: "00000000-0000-4000-8000-000000000003",
          name: "Plan.md",
          status:
            kind === "source_ready" ? ("ready" as const) : ("failed" as const)
        }
      }
    : {}),
  at
});

describe("Project HQ catch-up activity", () => {
  it("pages from the seen cursor and leaves already-visible Work Items, Sources, and PRs out", async () => {
    const activityPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          event("one", "work_item_created"),
          event("two", "source_ready")
        ],
        hasMore: true,
        nextCursor: "two"
      })
      .mockResolvedValueOnce({
        items: [
          event("three", "pr_opened"),
          event("four", "assertion_created")
        ],
        hasMore: false,
        nextCursor: null
      });
    const result = await loadUnseenProjectActivity(
      { activitySeen: async () => ({ cursor: "seen", at }), activityPage },
      "project",
      () => true
    );
    expect(activityPage.mock.calls).toEqual([
      ["project", "seen"],
      ["project", "two"]
    ]);
    expect(result.items.map((item) => item.kind)).toEqual([
      "source_ready",
      "assertion_created"
    ]);
    expect(result.highWater).toBe("four");
  });

  it("does not return activity after identity loss or a stalled page cursor", async () => {
    let current = true;
    await expect(
      loadUnseenProjectActivity(
        {
          activitySeen: async () => ({ cursor: "seen", at }),
          activityPage: async () => {
            current = false;
            return {
              items: [event("one", "source_ready")],
              hasMore: false,
              nextCursor: null
            };
          }
        },
        "project",
        () => current
      )
    ).rejects.toThrow("identity changed");
    await expect(
      loadUnseenProjectActivity(
        {
          activitySeen: async () => ({ cursor: "seen", at }),
          activityPage: async () => ({
            items: [],
            hasMore: true,
            nextCursor: "seen"
          })
        },
        "project",
        () => true
      )
    ).rejects.toThrow("did not advance");
  });

  it("drops an extraction event when the current attempt no longer resolves", async () => {
    const old = { ...event("old", "source_ready"), sourceOutcome: undefined };
    const result = await loadUnseenProjectActivity(
      {
        activitySeen: async () => ({ cursor: "seen", at }),
        activityPage: async () => ({
          items: [old],
          hasMore: false,
          nextCursor: null
        })
      },
      "project",
      () => true
    );
    expect(result.items).toEqual([]);
    expect(result.highWater).toBe("old");
  });
});
