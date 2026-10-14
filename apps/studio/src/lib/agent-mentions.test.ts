import { describe, expect, it } from "vitest";
import {
  matchMentionCandidates,
  mentionQueryAtCursor,
  resolvedAgentMentionIds,
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

  it("resolves only current draft mentions in first-seen order and deduplicates stable IDs", () => {
    const recipients = resolvedAgentMentionIds(
      "@bob_1 @bobby @bob_1 and not @unknown",
      [
        {
          id: "bob-1",
          name: "Bob",
          mentionToken: "bob_1",
          lifecycle: "active"
        },
        {
          id: "bobby",
          name: "Bobby",
          mentionToken: "bobby",
          lifecycle: "active"
        },
        {
          id: "retired",
          name: "Old Bob",
          mentionToken: "old_bob",
          lifecycle: "retired"
        }
      ],
      { bob_1: "bob-1", bobby: "bobby", old_bob: "retired" }
    );

    expect(recipients).toEqual(["bob-1", "bobby"]);
    expect(resolvedAgentMentionIds("@bobby", agents, { bob: "bob-1" })).toEqual(
      []
    );
  });

  it("does not turn quoted mentions into recipients", () => {
    expect(
      resolvedAgentMentionIds(
        'Discuss "@bob_1" then ask @bobby',
        [
          {
            id: "bob-1",
            name: "Bob",
            mentionToken: "bob_1",
            lifecycle: "active"
          },
          {
            id: "bobby",
            name: "Bobby",
            mentionToken: "bobby",
            lifecycle: "active"
          }
        ],
        { bob_1: "bob-1", bobby: "bobby" }
      )
    ).toEqual(["bobby"]);
  });

  it("does not treat apostrophes in contractions or possessives as quoted text", () => {
    expect(
      resolvedAgentMentionIds(
        "Don't lose the user's note. Ask @ada_1 next.",
        [
          { id: "ada", name: "Ada", mentionToken: "ada_1", lifecycle: "active" }
        ],
        { ada_1: "ada" }
      )
    ).toEqual(["ada"]);
  });

  it("ignores Markdown blockquotes, inline code, and fenced code", () => {
    const candidates = [
      {
        id: "ada",
        name: "Ada",
        mentionToken: "ada_1",
        lifecycle: "active" as const
      },
      {
        id: "bex",
        name: "Bex",
        mentionToken: "bex_2",
        lifecycle: "active" as const
      }
    ];
    expect(
      resolvedAgentMentionIds(
        [
          "> @ada_1 is quoted",
          "Use `@bex_2` only as an example.",
          "```text",
          "@ada_1",
          "```",
          "Please ask @bex_2."
        ].join("\n"),
        candidates,
        { ada_1: "ada", bex_2: "bex" }
      )
    ).toEqual(["bex"]);
    expect(mentionQueryAtCursor("`@Ada", 5)).toBeNull();
    expect(mentionQueryAtCursor("> @Ada", 6)).toBeNull();
  });

  it("does not trust a resolved token after its Agent's canonical token changes", () => {
    expect(
      resolvedAgentMentionIds(
        "@ada_old",
        [
          {
            id: "ada",
            name: "Ada",
            mentionToken: "ada_new",
            lifecycle: "active"
          }
        ],
        { ada_old: "ada" }
      )
    ).toEqual([]);
  });
});
