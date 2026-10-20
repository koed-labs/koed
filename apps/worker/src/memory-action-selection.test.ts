import { describe, expect, it } from "vitest";
import type { LcmGraphEvent, ManagedConversationTurnCitation } from "@koed/db";
import { selectManagedMemoryCitation } from "./memory-action-selection.js";

const ownedAlias = `r${"a".repeat(32)}c1`;
const teammateAlias = `r${"b".repeat(32)}c1`;
const citations = [
  { alias: ownedAlias, visibility: "personal" },
  { alias: teammateAlias, visibility: "team" }
] as ManagedConversationTurnCitation[];
const event = (timestamp: string, content: string) =>
  ({ actor: "agent", timestamp, content, sourceSequence: 1 }) as LcmGraphEvent;

describe("managed memory citation selection", () => {
  const assistantEvents = [
    event("2026-10-20T10:00:00Z", `Earlier claim [m:${ownedAlias}]`),
    event("2026-10-20T10:01:00Z", `Latest claim [m:${teammateAlias}]`)
  ];
  const base = {
    assistantEvents,
    citations,
    commandCreatedAt: "2026-10-20T10:02:00Z",
    userPrompt: "Forget that"
  };

  it("keeps an unqualified request on the latest actually cited teammate item", () => {
    expect(selectManagedMemoryCitation(base)).toEqual({
      kind: "selected",
      citation: citations[1]
    });
  });

  it("does not let a model-supplied alias redirect an unqualified request", () => {
    expect(
      selectManagedMemoryCitation({ ...base, requestedAlias: ownedAlias })
    ).toEqual({ kind: "ask", reason: "ambiguous" });
  });

  it("honors the exact alias when it appears in the User's prompt", () => {
    expect(
      selectManagedMemoryCitation({
        ...base,
        userPrompt: `Forget ${ownedAlias}`,
        requestedAlias: ownedAlias
      })
    ).toEqual({ kind: "selected", citation: citations[0] });
  });

  it("rejects unrendered and multiple explicit references", () => {
    const unknownAlias = `r${"c".repeat(32)}c1`;
    expect(
      selectManagedMemoryCitation({
        ...base,
        userPrompt: `Forget ${unknownAlias}`
      })
    ).toEqual({ kind: "ask", reason: "uncited" });
    expect(
      selectManagedMemoryCitation({
        ...base,
        userPrompt: `Forget ${ownedAlias} and ${teammateAlias}`
      })
    ).toEqual({ kind: "ask", reason: "ambiguous" });
  });

  it("uses displayed first-occurrence numbering in the latest cited answer", () => {
    const numbered = {
      ...base,
      assistantEvents: [
        event(
          "2026-10-20T10:01:00Z",
          `First [m:${ownedAlias}], second [m:${teammateAlias}], repeated [m:${ownedAlias}]`
        )
      ]
    };
    expect(
      selectManagedMemoryCitation({
        ...numbered,
        userPrompt: "Forget citation 2"
      })
    ).toEqual({ kind: "selected", citation: citations[1] });
    expect(
      selectManagedMemoryCitation({
        ...numbered,
        userPrompt: "Forget memory #1"
      })
    ).toEqual({ kind: "selected", citation: citations[0] });
    expect(
      selectManagedMemoryCitation({
        ...numbered,
        userPrompt: "Forget citation 3"
      })
    ).toEqual({ kind: "ask", reason: "uncited" });
  });

  it("asks when the same displayed citation number occurs in multiple answers", () => {
    const repeated = {
      ...base,
      assistantEvents: [
        event(
          "2026-10-20T10:00:00Z",
          `One [m:${ownedAlias}] two [m:${teammateAlias}]`
        ),
        event(
          "2026-10-20T10:01:00Z",
          `One [m:${teammateAlias}] two [m:${ownedAlias}]`
        )
      ]
    };
    expect(
      selectManagedMemoryCitation({
        ...repeated,
        userPrompt: "Forget citation 2"
      })
    ).toEqual({ kind: "ask", reason: "ambiguous" });
    expect(
      selectManagedMemoryCitation({
        ...repeated,
        userPrompt: "Forget citation 2 in your latest answer"
      })
    ).toEqual({ kind: "selected", citation: citations[0] });
  });

  it("never skips the latest teammate answer to satisfy a missing ordinal in an older answer", () => {
    const latestTeamOne = {
      ...base,
      assistantEvents: [
        event(
          "2026-10-20T10:00:00Z",
          `One [m:${teammateAlias}] two [m:${ownedAlias}]`
        ),
        event("2026-10-20T10:01:00Z", `One [m:${teammateAlias}]`)
      ]
    };
    expect(
      selectManagedMemoryCitation({
        ...latestTeamOne,
        userPrompt: "Forget latest memory #2"
      })
    ).toEqual({ kind: "ask", reason: "uncited" });
  });

  it("does not treat retrieved aliases or the current turn as earlier citations", () => {
    expect(
      selectManagedMemoryCitation({
        ...base,
        assistantEvents: [
          event("2026-10-20T10:03:00Z", `Now [m:${ownedAlias}]`)
        ]
      })
    ).toEqual({ kind: "ask", reason: "uncited" });
  });
});
