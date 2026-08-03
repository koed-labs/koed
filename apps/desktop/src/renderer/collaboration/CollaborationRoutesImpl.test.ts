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
    expect(
      modalIsAuthorized(
        {
          kind: "share_personal_memory",
          sessionId: "018f47f2-e195-7c5b-a33c-2ef5f7036a12"
        },
        snapshot,
        new Set(["018f47f2-e195-7c5b-a33c-2ef5f7036a12"])
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
        snapshot,
        new Set()
      )
    ).toBe(false);
  });
});
