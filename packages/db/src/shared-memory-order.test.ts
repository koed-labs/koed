import { describe, expect, it } from "vitest";
import { compareSharedMemoryEventOrder } from "./shared-memory-repository.js";

describe("Shared Memory event order", () => {
  it("keeps delayed catch-up materialization in transcript chronology", () => {
    const events = [
      {
        eventId: "00000000-0000-4000-8000-000000000003",
        sourceCursor: 9,
        occurredAt: "2026-07-29T11:50:02.000Z"
      },
      {
        eventId: "00000000-0000-4000-8000-000000000002",
        sourceCursor: 8,
        occurredAt: "2026-07-29T11:30:06.366Z"
      },
      {
        eventId: "00000000-0000-4000-8000-000000000001",
        sourceCursor: 7,
        occurredAt: "2026-07-29T11:50:01.000Z"
      }
    ];

    expect(events.sort(compareSharedMemoryEventOrder)).toEqual([
      expect.objectContaining({
        occurredAt: "2026-07-29T11:30:06.366Z"
      }),
      expect.objectContaining({
        occurredAt: "2026-07-29T11:50:01.000Z"
      }),
      expect.objectContaining({
        occurredAt: "2026-07-29T11:50:02.000Z"
      })
    ]);
  });
});
