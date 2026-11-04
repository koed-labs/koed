import { describe, expect, it, vi } from "vitest";
import type { PersonalSelectionSnapshot } from "@koed/shared";
import { listSelectedPersonalThreads } from "./personal-selection-inventory.js";

const actor = { userId: "00000000-0000-4000-8000-000000000001" };
const selection: PersonalSelectionSnapshot = {
  version: 1,
  ownerUserId: actor.userId,
  target: {
    kind: "project",
    project: {
      ownerUserId: actor.userId,
      projectId: "00000000-0000-4000-8000-000000000002"
    }
  }
};
const stale = () =>
  Object.assign(new Error("Changed"), {
    code: "selection_enumeration_stale",
    statusCode: 409
  });
function fixture() {
  let attempt = 0;
  const selections = {
    startPersonalSelectionEnumeration: vi.fn(
      async (): Promise<{
        entries: { source: { localSessionId: string } }[];
        nextCursor: string | null;
        changeCursor: string | null;
      }> => ({
        entries: [{ source: { localSessionId: `session-${++attempt}` } }],
        nextCursor: null,
        changeCursor: `checkpoint-${attempt}`
      })
    ),
    continuePersonalSelectionEnumeration: vi.fn(),
    reconcilePersonalSelectionChanges: vi.fn(async () => ({
      reconciliationRequired: false
    }))
  };
  const repo = {
    personalInventorySelections: selections,
    startPersonalSelectionEnumeration: vi.fn(),
    continuePersonalSelectionEnumeration: vi.fn(),
    reconcilePersonalSelectionChanges: vi.fn(),
    listLcmGraphThreads: vi.fn(
      async (_actor: typeof actor, input: { sessionIds: string[] }) => [
        {
          threads: input.sessionIds.map((sessionId: string) => ({
            id: sessionId,
            sessionId,
            latestAt: "2026-11-04T12:00:00Z"
          }))
        }
      ]
    )
  };
  const read = () =>
    listSelectedPersonalThreads(
      repo as unknown as Parameters<typeof listSelectedPersonalThreads>[0],
      actor,
      selection,
      "Project"
    );
  return { repo, selections, read };
}

describe("Personal inventory enumeration", () => {
  it("discards an invalidated attempt and uses the inspection adapter", async () => {
    const { repo, selections, read } = fixture();
    selections.reconcilePersonalSelectionChanges.mockResolvedValueOnce({
      reconciliationRequired: true
    });
    expect(await read()).toMatchObject([{ sessionId: "session-2" }]);
    expect(selections.startPersonalSelectionEnumeration).toHaveBeenCalledTimes(
      2
    );
    expect(repo.startPersonalSelectionEnumeration).not.toHaveBeenCalled();
    expect(repo.listLcmGraphThreads).toHaveBeenLastCalledWith(actor, {
      personalSelection: selection,
      sessionIds: ["session-2"],
      limit: 1,
      offset: 0,
      groupBySession: true
    });
  });

  it("restarts after a stale continuation without retaining partial headers", async () => {
    const { selections, read } = fixture();
    selections.startPersonalSelectionEnumeration.mockResolvedValueOnce({
      entries: [{ source: { localSessionId: "discarded" } }],
      nextCursor: "next",
      changeCursor: null
    });
    selections.continuePersonalSelectionEnumeration.mockRejectedValueOnce(
      stale()
    );
    expect(await read()).toMatchObject([{ sessionId: "session-1" }]);
  });

  it("bounds retries during repeated membership changes", async () => {
    const { selections, read } = fixture();
    selections.reconcilePersonalSelectionChanges.mockResolvedValue({
      reconciliationRequired: true
    });
    await expect(read()).rejects.toMatchObject({
      code: "selection_enumeration_stale"
    });
    expect(selections.startPersonalSelectionEnumeration).toHaveBeenCalledTimes(
      3
    );
  });

  it("does not retry authorization or unavailable-source failures", async () => {
    const { selections, read } = fixture();
    const unavailable = Object.assign(new Error("Unavailable"), {
      statusCode: 404
    });
    selections.startPersonalSelectionEnumeration.mockRejectedValueOnce(
      unavailable
    );
    await expect(read()).rejects.toBe(unavailable);
    expect(selections.startPersonalSelectionEnumeration).toHaveBeenCalledTimes(
      1
    );
  });
});
