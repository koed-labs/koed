import type { CollaborationSnapshot } from "@koed/shared";
import { describe, expect, it } from "vitest";

import { modalIsAuthorized } from "./CollaborationRoutesImpl.js";

const snapshot = {
  navigation: {
    personal: { memory: [] },
    teams: []
  }
} as unknown as CollaborationSnapshot;

describe("collaboration modal authorization", () => {
  it("authorizes a freshly captured local session before collaboration convergence", () => {
    const sessionId = "018f47f2-e195-7c5b-a33c-2ef5f7036a12";
    expect(
      modalIsAuthorized(
        {
          kind: "share_personal_memory",
          sessionId,
          localEntry: {
            id: sessionId,
            logicalMemoryId: "33333333-3333-4333-8333-333333333333",
            title: "Local capture",
            projectName: "koed",
            updatedAt: "2026-08-05T12:00:00.000Z",
            preview: "A local Captured Session.",
            eventCount: 2,
            hasSynchronizedRevision: false,
            syncState: "not_started"
          }
        },
        snapshot
      )
    ).toBe(true);
  });

  it("rejects an unknown Personal session", () => {
    expect(
      modalIsAuthorized(
        {
          kind: "share_personal_memory",
          sessionId: "018f47f2-e195-7c5b-a33c-2ef5f7036a12"
        },
        snapshot
      )
    ).toBe(false);
  });

  it("rejects a local entry that does not match the requested session", () => {
    expect(
      modalIsAuthorized(
        {
          kind: "share_personal_memory",
          sessionId: "018f47f2-e195-7c5b-a33c-2ef5f7036a12",
          localEntry: {
            id: "018f47f2-e195-7c5b-a33c-2ef5f7036a13",
            logicalMemoryId: null,
            title: "Different local capture",
            projectName: "koed",
            updatedAt: "2026-08-05T12:00:00.000Z",
            preview: "Another local Captured Session.",
            eventCount: 1,
            hasSynchronizedRevision: false,
            syncState: "not_started"
          }
        },
        snapshot
      )
    ).toBe(false);
  });
});
