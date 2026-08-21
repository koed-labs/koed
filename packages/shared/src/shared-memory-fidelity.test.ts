import { describe, expect, it } from "vitest";
import {
  intersectSharedMemoryFidelityCeilings,
  sharedMemoryCeilingAuthorizes,
  sharedMemoryRepresentationsForCeiling
} from "./shared-memory-fidelity.js";

describe("shared memory fidelity", () => {
  it.each([
    ["memory_events", ["lcm_rollups", "lcm_leaves", "memory_events"]],
    ["lcm_leaves", ["lcm_rollups", "lcm_leaves"]],
    ["lcm_rollups", ["lcm_rollups"]]
  ] as const)("expands %s cumulatively", (ceiling, expected) => {
    expect(sharedMemoryRepresentationsForCeiling(ceiling)).toEqual(expected);
  });

  it("keeps curated assertions independent", () => {
    expect(
      sharedMemoryCeilingAuthorizes("memory_events", "curated_assertions")
    ).toBe(false);
    expect(
      sharedMemoryCeilingAuthorizes("lcm_rollups", "curated_assertions", true)
    ).toBe(true);
  });

  it("intersects at the least permissive ceiling", () => {
    expect(
      intersectSharedMemoryFidelityCeilings(
        "memory_events",
        "lcm_leaves",
        "lcm_rollups"
      )
    ).toBe("lcm_rollups");
    expect(
      intersectSharedMemoryFidelityCeilings("memory_events", null)
    ).toBeNull();
  });
});
