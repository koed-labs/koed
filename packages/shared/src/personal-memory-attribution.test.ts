import { describe, expect, it } from "vitest";
import {
  parsePersonalMemoryAttributionFooter,
  personalMemoryAttributionFooter,
  stripPersonalMemoryAttributionFooter
} from "./personal-memory-attribution.js";

const commandId = "11111111-1111-4111-8111-111111111111";
const nonce = "22222222-2222-4222-8222-222222222222";

describe("Personal Memory attribution footer", () => {
  it("parses a final raw JSON footer bound to its command and nonce", () => {
    const footer = personalMemoryAttributionFooter({
      commandId,
      nonce,
      attribution: { used: true, citationNodeIds: ["node-1"] }
    });
    const result = parsePersonalMemoryAttributionFooter(
      `Answer text\n${footer}`,
      { commandId, nonce }
    );

    expect(result).toEqual({
      text: "Answer text",
      attribution: { used: true, citationNodeIds: ["node-1"] },
      recognizedFooter: true
    });
  });

  it("strips malformed, duplicate, and wrong-case reserved footer text", () => {
    const malformed = `Answer\n<!-- koed-memory-attribution:v1:${commandId}:${nonce}:{bad} -->`;
    const duplicate = `Answer\n<!-- koed-memory-attribution:v1:bad -->\n<!-- koed-memory-attribution:v1:${commandId}:${nonce}:{"used":false,"citationNodeIds":[]} -->`;
    const uppercase = `Answer\n<!-- KOED-MEMORY-ATTRIBUTION:v1:${commandId}:${nonce}:{"used":false,"citationNodeIds":[]} -->`;

    expect(stripPersonalMemoryAttributionFooter(malformed)).toBe("Answer");
    expect(stripPersonalMemoryAttributionFooter(duplicate)).toBe("Answer");
    expect(stripPersonalMemoryAttributionFooter(uppercase)).toBe("Answer");
  });

  it("fails closed on wrong command or nonce while preserving visible text", () => {
    const footer = personalMemoryAttributionFooter({
      commandId,
      nonce,
      attribution: { used: true, citationNodeIds: ["node-1"] }
    });
    const text = `Answer\n${footer}`;

    expect(
      parsePersonalMemoryAttributionFooter(text, {
        commandId: "33333333-3333-4333-8333-333333333333",
        nonce
      })
    ).toMatchObject({
      text: "Answer",
      attribution: null,
      recognizedFooter: true
    });
    expect(
      parsePersonalMemoryAttributionFooter(text, {
        commandId,
        nonce: "44444444-4444-4444-8444-444444444444"
      })
    ).toMatchObject({
      text: "Answer",
      attribution: null,
      recognizedFooter: true
    });
  });

  it("distinguishes partial stream markers from ordinary final angle brackets", () => {
    expect(stripPersonalMemoryAttributionFooter("Answer\n<")).toBe("Answer");
    expect(
      stripPersonalMemoryAttributionFooter("Answer\n<!-- koed-mem", {
        mode: "final"
      })
    ).toBe("Answer");
    expect(
      stripPersonalMemoryAttributionFooter("Answer <", { mode: "final" })
    ).toBe("Answer <");
  });
});
