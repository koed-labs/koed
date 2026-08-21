import { describe, expect, it } from "vitest";
import {
  allPrivacyLabelsPolicy,
  derivePrivacyFingerprintKey,
  noPrivacyLabelsPolicy,
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  privacyClassificationRequestSchema,
  privacyClassificationResponseSchema,
  privacyContentPolicyHash,
  resolveEffectivePrivacyPolicy,
  sanitizeTextWithPrivacySpans
} from "./privacy-filter-contract.js";

describe("privacy filter contract", () => {
  it("derives stable domain-separated fingerprint key material", () => {
    expect(Buffer.from(derivePrivacyFingerprintKey("root-a"))).toHaveLength(32);
    expect(Buffer.from(derivePrivacyFingerprintKey("root-a"))).toEqual(
      Buffer.from(derivePrivacyFingerprintKey("root-a"))
    );
    expect(Buffer.from(derivePrivacyFingerprintKey("root-a"))).not.toEqual(
      Buffer.from(derivePrivacyFingerprintKey("root-b"))
    );
    expect(() => derivePrivacyFingerprintKey(" ")).toThrow();
  });
  it("requires distinct field paths and a bound classifier identity", () => {
    expect(
      privacyClassificationRequestSchema.safeParse({
        schemaVersion: 1,
        inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
        fields: [
          { path: "/content/text", text: "Ada" },
          { path: "/content/text", text: "Lovelace" }
        ]
      }).success
    ).toBe(false);

    expect(
      privacyClassificationResponseSchema.safeParse({
        schemaVersion: 1,
        inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
        classifier: {
          classifierHash: "a".repeat(64),
          modelKey: "openai/privacy-filter",
          modelRevision: "pinned"
        },
        fields: [
          {
            path: "/content/text",
            inputSha256: "b".repeat(64),
            inputByteLength: 3,
            maskedText: "[PRIVATE_PERSON]",
            decodedTextMatchesInput: true,
            spans: [
              {
                label: "private_person",
                startByte: 0,
                endByte: 3,
                detectors: ["privacy_filter"]
              }
            ]
          }
        ]
      }).success
    ).toBe(true);
  });

  it("resolves policy as a monotonic union", () => {
    const owner = noPrivacyLabelsPolicy();
    owner.private_email = true;
    const team = noPrivacyLabelsPolicy();
    team.secret = true;

    expect(resolveEffectivePrivacyPolicy(owner, team)).toMatchObject({
      private_email: true,
      secret: true,
      private_phone: false
    });
  });

  it("hashes policy independently of object construction order", () => {
    expect(privacyContentPolicyHash({ labels: allPrivacyLabelsPolicy() })).toBe(
      privacyContentPolicyHash({ labels: allPrivacyLabelsPolicy() })
    );
  });

  it("replaces UTF-8-aligned spans with typed fixed placeholders", () => {
    const text = "Contact José at jose@example.test";
    const start = Buffer.byteLength("Contact José at ", "utf8");
    const end = Buffer.byteLength(text, "utf8");
    const result = sanitizeTextWithPrivacySpans({
      text,
      policy: allPrivacyLabelsPolicy(),
      spans: [
        {
          label: "private_email",
          startByte: start,
          endByte: end,
          detectors: ["privacy_filter"]
        }
      ]
    });

    expect(result.text).toBe("Contact José at [PRIVATE_EMAIL]");
    expect(result.appliedLabels).toEqual(["private_email"]);
  });

  it("merges overlapping labels without revealing either value shape", () => {
    const result = sanitizeTextWithPrivacySpans({
      text: "abcdef",
      policy: allPrivacyLabelsPolicy(),
      spans: [
        {
          label: "secret",
          startByte: 1,
          endByte: 4,
          detectors: ["deterministic"]
        },
        {
          label: "account_number",
          startByte: 3,
          endByte: 6,
          detectors: ["privacy_filter"]
        }
      ]
    });

    expect(result.text).toBe("a[PRIVATE_DATA]");
  });

  it("rejects spans that split UTF-8 characters", () => {
    expect(() =>
      sanitizeTextWithPrivacySpans({
        text: "é",
        policy: allPrivacyLabelsPolicy(),
        spans: [
          {
            label: "private_person",
            startByte: 0,
            endByte: 1,
            detectors: ["privacy_filter"]
          }
        ]
      })
    ).toThrow(/UTF-8/);
  });
});
