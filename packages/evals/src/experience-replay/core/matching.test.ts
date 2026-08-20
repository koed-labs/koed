import { describe, expect, it } from "vitest";
import {
  assignProductPathProofPlacebo,
  assignMatchedPlacebos,
  verifyPlaceboAssignment,
  type PlaceboCandidate
} from "./matching.js";

const candidates: PlaceboCandidate[] = [
  {
    taskDigest: "a",
    category: "shell",
    sourcePassed: true,
    sanitizedTokenQuartile: 0,
    expertTimeSeconds: 100,
    resourceClass: "cpu"
  },
  {
    taskDigest: "b",
    category: "shell",
    sourcePassed: true,
    sanitizedTokenQuartile: 0,
    expertTimeSeconds: 110,
    resourceClass: "cpu"
  },
  {
    taskDigest: "c",
    category: "data",
    sourcePassed: false,
    sanitizedTokenQuartile: 3,
    expertTimeSeconds: 300,
    resourceClass: "cpu"
  },
  {
    taskDigest: "d",
    category: "data",
    sourcePassed: false,
    sanitizedTokenQuartile: 3,
    expertTimeSeconds: 310,
    resourceClass: "cpu"
  }
];

describe("matched placebo assignment", () => {
  it("produces a deterministic perfect derangement with complete immutable edge inputs", () => {
    const assignment = assignMatchedPlacebos(candidates, "run-seed");
    verifyPlaceboAssignment(assignment);
    expect(
      assignMatchedPlacebos([...candidates].reverse(), "run-seed")
    ).toEqual(assignment);
    expect(assignment.edges).toHaveLength(12);
    expect(
      new Set(assignment.assignments.map((item) => item.sourceDigest))
    ).toEqual(new Set(["a", "b", "c", "d"]));
    expect(
      assignment.assignments.every(
        (item) => item.targetDigest !== item.sourceDigest
      )
    ).toBe(true);
    expect(assignment.assignments).toEqual([
      { targetDigest: "a", sourceDigest: "b" },
      { targetDigest: "b", sourceDigest: "a" },
      { targetDigest: "c", sourceDigest: "d" },
      { targetDigest: "d", sourceDigest: "c" }
    ]);
    expect(Object.isFrozen(assignment.edges)).toBe(true);
  });

  it("fails preflight for singleton resource strata", () => {
    expect(() =>
      assignMatchedPlacebos([candidates[0] as PlaceboCandidate], "seed")
    ).toThrow("fewer than two");
  });

  it("breaks ambiguous optima by lexicographic complete-assignment order", () => {
    const ambiguous = candidates.map((candidate) => ({
      ...candidate,
      category: "same",
      sourcePassed: true,
      sanitizedTokenQuartile: 0 as const,
      expertTimeSeconds: 100
    }));

    expect(assignMatchedPlacebos(ambiguous, "ambiguous-1").assignments).toEqual(
      [
        { targetDigest: "a", sourceDigest: "b" },
        { targetDigest: "b", sourceDigest: "c" },
        { targetDigest: "c", sourceDigest: "d" },
        { targetDigest: "d", sourceDigest: "a" }
      ]
    );
  });

  it("rejects tampered persisted assignments", () => {
    const assignment = assignMatchedPlacebos(candidates, "run-seed");
    const changed = structuredClone(assignment);
    (changed.assignments[0] as { sourceDigest: string }).sourceDigest = "c";
    expect(() => verifyPlaceboAssignment(changed)).toThrow("hash mismatch");
  });

  it("records the proof target-to-donor edge without relaxing benchmark matching", () => {
    const assignment = assignProductPathProofPlacebo(
      candidates[0] as PlaceboCandidate,
      candidates[1] as PlaceboCandidate,
      "proof-seed"
    );
    expect(assignment.assignments).toEqual([
      { targetDigest: "a", sourceDigest: "b" }
    ]);
    expect(assignment.edges).toHaveLength(1);
    expect(() => verifyPlaceboAssignment(assignment)).not.toThrow();
    expect(() =>
      assignProductPathProofPlacebo(
        candidates[0] as PlaceboCandidate,
        candidates[0] as PlaceboCandidate,
        "proof-seed"
      )
    ).toThrow("distinct");
  });
});
