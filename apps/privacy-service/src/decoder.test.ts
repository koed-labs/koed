import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodeBioesViterbi,
  isValidTransition,
  parseViterbiCalibration,
  ZERO_VITERBI_BIASES
} from "./decoder.js";
import { PRIVACY_LABELS, TOKEN_LABELS, type TokenLabel } from "./labels.js";

type OfficialFixture = {
  source: { repository: string; revision: string; module: string };
  cases: Array<{
    name: string;
    biases: Record<string, number>;
    emissions: Array<Record<string, number>>;
    expected: TokenLabel[];
  }>;
};

const officialFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/official-viterbi-parity.json", import.meta.url),
    "utf8"
  )
) as OfficialFixture;

const row = (scores: Partial<Record<TokenLabel, number>>): number[] =>
  TOKEN_LABELS.map((label) => scores[label] ?? -20);

describe("constrained BIOES Viterbi decoder", () => {
  it("exports the exact fixed OpenAI Privacy Filter label space", () => {
    expect(PRIVACY_LABELS).toEqual([
      "account_number",
      "private_address",
      "private_email",
      "private_person",
      "private_phone",
      "private_url",
      "private_date",
      "secret"
    ]);
    expect(TOKEN_LABELS).toHaveLength(33);
    expect(TOKEN_LABELS[0]).toBe("O");
    expect(TOKEN_LABELS[9]).toBe("B-private_date");
    expect(TOKEN_LABELS[13]).toBe("B-private_email");
    expect(TOKEN_LABELS[32]).toBe("S-secret");
  });

  it("rejects invalid BIOES edges and cross-label continuation", () => {
    expect(isValidTransition("O", "I-private_email")).toBe(false);
    expect(isValidTransition("B-private_email", "E-private_person")).toBe(
      false
    );
    expect(isValidTransition("B-private_email", "I-private_email")).toBe(true);
    expect(isValidTransition("E-private_email", "B-private_person")).toBe(true);
  });

  it("finds the best complete valid path instead of independent argmax", () => {
    const decoded = decodeBioesViterbi([
      row({ "B-private_email": 10, "S-private_email": 9 }),
      row({ O: 10, "E-private_email": 8 })
    ]);
    expect(decoded).toEqual(["S-private_email", "O"]);
  });

  it("supports coherent multi-token and adjacent spans", () => {
    const decoded = decodeBioesViterbi([
      row({ "B-private_person": 10 }),
      row({ "I-private_person": 10 }),
      row({ "E-private_person": 10 }),
      row({ "S-private_email": 10 })
    ]);
    expect(decoded).toEqual([
      "B-private_person",
      "I-private_person",
      "E-private_person",
      "S-private_email"
    ]);
  });

  it("uses the official all-zero default calibration", () => {
    expect(ZERO_VITERBI_BIASES).toEqual({
      backgroundStay: 0,
      backgroundToStart: 0,
      insideToContinue: 0,
      insideToEnd: 0,
      endToBackground: 0,
      endToStart: 0
    });
    expect(
      decodeBioesViterbi(
        [row({ "B-secret": 2, "S-secret": 1 }), row({ "E-secret": 2 })],
        ZERO_VITERBI_BIASES
      )
    ).toEqual(["B-secret", "E-secret"]);
  });

  it("matches immutable fixtures derived from the pinned official opf decoder", () => {
    expect(officialFixture.source).toEqual({
      repository: "openai/privacy-filter",
      revision: "f7f00ca7fb869683eb732c010299d901457f19c3",
      module: "opf/_core/decoding.py"
    });
    for (const fixture of officialFixture.cases) {
      const biases = parseViterbiCalibration({
        operating_points: { default: { biases: fixture.biases } }
      });
      const logits = fixture.emissions.map((emissions) =>
        row(emissions as Partial<Record<TokenLabel, number>>)
      );
      expect(decodeBioesViterbi(logits, biases), fixture.name).toEqual(
        fixture.expected
      );
    }
  });

  it("rejects malformed or ambiguous calibration artifacts", () => {
    expect(() => parseViterbiCalibration({ operating_points: {} })).toThrow(
      /invalid schema/
    );
    expect(() =>
      parseViterbiCalibration({
        operating_points: {
          default: {
            biases: {
              transition_bias_background_stay: true,
              transition_bias_background_to_start: 0,
              transition_bias_inside_to_continue: 0,
              transition_bias_inside_to_end: 0,
              transition_bias_end_to_background: 0,
              transition_bias_end_to_start: 0
            }
          }
        }
      })
    ).toThrow(/must be finite/);
  });

  it("rejects malformed and non-finite emission matrices", () => {
    expect(() => decodeBioesViterbi([[1, 2]])).toThrow(/expected 33/);
    expect(() => decodeBioesViterbi([row({ O: Number.NaN })])).toThrow(
      /non-finite/
    );
  });
});
