import { describe, expect, it } from "vitest";
import {
  allPrivacyLabelsPolicy,
  derivePrivacyFingerprintKey,
  noPrivacyLabelsPolicy,
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES,
  PRIVACY_MAX_FIELD_TOKENS,
  privacyClassificationRequestSchema,
  privacyClassificationResponseSchema,
  privacyClassificationExpectedManifestHash,
  privacyClassificationOrderedInputHash,
  privacyClassificationResultManifestHash,
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

  it("binds ordered inputs, expected chunks, and result chunks separately", () => {
    const fields = [
      { path: "/0/content/text", text: "first" },
      { path: "/1/content/text", text: "second" }
    ];
    const chunk = {
      chunkIndex: 0,
      firstFieldIndex: 0,
      fieldCount: 2,
      inputIdentityHash: "1".repeat(64),
      orderedInputHash: privacyClassificationOrderedInputHash(fields)
    };
    expect(chunk.orderedInputHash).not.toBe(
      privacyClassificationOrderedInputHash([...fields].reverse())
    );
    const expectedManifestHash = privacyClassificationExpectedManifestHash({
      semanticPreviewId: "00000000-0000-4000-8000-000000000001",
      sourcePreviewHash: "2".repeat(64),
      sourceArtifactHash: "3".repeat(64),
      sourceManifestHash: "4".repeat(64),
      sourceRevision: 1,
      classifierGenerationId: "00000000-0000-4000-8000-000000000002",
      classifierHash: "5".repeat(64),
      effectivePrivacyPolicyHash: "6".repeat(64),
      fieldCount: 2,
      chunks: [chunk]
    });
    expect(expectedManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      privacyClassificationResultManifestHash({
        expectedManifestHash,
        chunks: [
          {
            ...chunk,
            classificationResultId: "00000000-0000-4000-8000-000000000003",
            classificationPayloadBindingHash: "7".repeat(64)
          }
        ]
      })
    ).not.toBe(expectedManifestHash);
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

  it("admits maximum-size UTF-8 fields under the pinned byte-token bound", () => {
    const repeatedCode = "const value = await lookup(input);\n";
    const byteHeavy = Array.from({ length: 128 }, (_, index) =>
      String.fromCharCode(index)
    ).join("");
    const fixtures = [
      "a".repeat(PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES),
      "é".repeat(PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES / 2),
      "😀".repeat(PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES / 4),
      repeatedCode
        .repeat(
          Math.ceil(
            PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES /
              Buffer.byteLength(repeatedCode, "utf8")
          )
        )
        .slice(0, PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES),
      byteHeavy.repeat(
        PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES /
          Buffer.byteLength(byteHeavy, "utf8")
      )
    ];
    for (const text of fixtures) {
      const utf8Bytes = Buffer.from(text, "utf8");
      expect(utf8Bytes).toHaveLength(PRIVACY_CLASSIFICATION_MAX_FIELD_BYTES);
      expect(utf8Bytes.length).toBeLessThanOrEqual(PRIVACY_MAX_FIELD_TOKENS);
      expect(
        privacyClassificationRequestSchema.safeParse({
          schemaVersion: 1,
          inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
          fields: [{ path: "/content/text", text }]
        }).success
      ).toBe(true);
    }
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
