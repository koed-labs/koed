import { describe, expect, it } from "vitest";
import {
  matchMentionCandidates,
  mentionQueryAtCursor,
  unresolvedAgentMentions
} from "./agent-mentions";

const agents = [
  { id: "bob-1", name: "Bob", lifecycle: "active" as const },
  { id: "bob-2", name: "Bob", lifecycle: "active" as const },
  { id: "retired", name: "Bobby", lifecycle: "retired" as const }
];

describe("agent mention helpers", () => {
  it("reads the mention query immediately before the caret", () => {
    expect(mentionQueryAtCursor("Review this @Bo", 15)).toEqual({
      query: "Bo",
      start: 12,
      end: 15
    });
    expect(mentionQueryAtCursor("email@Bob", 9)).toBeNull();
  });

  it("returns active candidates independently by stable ID", () => {
    expect(
      matchMentionCandidates("bo", agents).map((agent) => agent.id)
    ).toEqual(["bob-1", "bob-2"]);
  });

  it("blocks duplicate, retired, and unknown mentions but ignores quoted text", () => {
    expect(unresolvedAgentMentions("@Bob @Bobby @Nobody", agents)).toEqual([
      { name: "Bob", kind: "ambiguous", candidateIds: ["bob-1", "bob-2"] },
      { name: "Bobby", kind: "retired", candidateIds: ["retired"] },
      { name: "Nobody", kind: "unknown", candidateIds: [] }
    ]);
    expect(
      unresolvedAgentMentions('The text "@Nobody" is quoted.', agents)
    ).toEqual([]);
  });

  it("requires an explicit selection even when a name is unique", () => {
    expect(unresolvedAgentMentions("@Bobby", agents)).toEqual([
      { name: "Bobby", kind: "retired", candidateIds: ["retired"] }
    ]);
    expect(
      unresolvedAgentMentions("@Ada", [
        { id: "ada", name: "Ada", lifecycle: "active" }
      ])
    ).toEqual([{ name: "Ada", kind: "unselected", candidateIds: ["ada"] }]);
  });
});
