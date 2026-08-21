import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  extractSharedMemorySemanticClassificationFields,
  reconstructSharedMemorySemanticSanitizedItems,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  validateSharedMemoryCanonicalSourceItem,
  validateSharedMemorySemanticSanitizedReconstruction,
  type SharedMemoryCanonicalSourceItemDto
} from "./shared-memory-semantic-contract.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const semanticFixture = (): SharedMemoryCanonicalSourceItemDto[] => {
  const logicalMemoryId = randomUUID();
  return [
    {
      itemType: "lcm_leaf",
      schemaVersion: 1,
      sourceId: randomUUID(),
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision: 7,
      occurredAt: null,
      content: {
        title: "Customer context",
        summaryText: "Alice prefers morning calls.",
        lexicalAnchors: ["Alice"],
        sourceIds: [randomUUID()],
        expansionItems: [
          {
            itemType: "tool_result",
            schemaVersion: 1,
            sourceId: randomUUID(),
            sourceLogicalMemoryId: logicalMemoryId,
            sourceRevision: 7,
            occurredAt: null,
            content: {
              toolName: "customer_lookup",
              toolCallId: "call-immutable",
              payload: { count: 2, "customer.name": "Alice Example" }
            }
          }
        ]
      }
    }
  ];
};

describe("Shared Memory canonical semantic contract", () => {
  it("validates eligible items and reports stable rejection reasons", () => {
    const logicalMemoryId = randomUUID();
    const item = {
      itemType: "user_message",
      schemaVersion: 1,
      sourceId: randomUUID(),
      sourceLogicalMemoryId: logicalMemoryId,
      sourceRevision: 3,
      content: { text: "Eligible content" }
    };

    expect(
      validateSharedMemoryCanonicalSourceItem({
        representation: "memory_events",
        logicalMemoryId,
        sourceRevision: 3,
        item
      })
    ).toMatchObject({
      occurredAt: null,
      content: { text: "Eligible content" }
    });
    expect(() =>
      validateSharedMemoryCanonicalSourceItem({
        representation: "lcm_leaves",
        logicalMemoryId,
        sourceRevision: 3,
        item
      })
    ).toThrowError(
      expect.objectContaining({
        name: "SharedMemorySourceItemRejectedError",
        reasonCode: "wrong_representation"
      })
    );
    expect(() =>
      validateSharedMemoryCanonicalSourceItem({
        representation: "memory_events",
        logicalMemoryId,
        sourceRevision: 3,
        item: { ...item, classification: { hiddenReasoning: true } }
      })
    ).toThrow(SharedMemorySourceItemRejectedError);
  });

  it("extracts every semantic string with stable paths and hashes", () => {
    const fields =
      extractSharedMemorySemanticClassificationFields(semanticFixture());

    expect(fields.map(({ path }) => path)).toEqual([
      "items.0.content.title",
      "items.0.content.summaryText",
      "items.0.content.lexicalAnchors.0",
      "items.0.content.expansionItems.0.content.toolName",
      "items.0.content.expansionItems.0.content.payload.$key.0",
      "items.0.content.expansionItems.0.content.payload.$key.1",
      'items.0.content.expansionItems.0.content.payload["customer.name"]'
    ]);
    for (const field of fields) {
      expect(field.inputSha256).toBe(sha256(field.text));
      expect(field.inputByteLength).toBe(Buffer.byteLength(field.text, "utf8"));
    }
  });

  it("reconstructs only the exact ordered replaceable field contract", () => {
    const authoritative = semanticFixture();
    const maskedFields = extractSharedMemorySemanticClassificationFields(
      authoritative
    ).map((field) => ({
      path: field.path,
      inputSha256: field.inputSha256,
      inputByteLength: field.inputByteLength,
      sanitizedText: field.text.replaceAll("Alice", "[PERSON_1]")
    }));
    const protectedKey = maskedFields.findIndex(({ path }) =>
      path.includes(".$key.")
    );
    maskedFields[protectedKey]!.sanitizedText =
      extractSharedMemorySemanticClassificationFields(authoritative)[
        protectedKey
      ]!.text;

    const reconstructed = reconstructSharedMemorySemanticSanitizedItems(
      authoritative,
      maskedFields
    );
    expect(reconstructed[0]!.content.summaryText).toBe(
      "[PERSON_1] prefers morning calls."
    );
    expect(authoritative[0]!.content.summaryText).toBe(
      "Alice prefers morning calls."
    );
    expect(() =>
      reconstructSharedMemorySemanticSanitizedItems(
        authoritative,
        maskedFields.slice(1)
      )
    ).toThrow(SharedMemoryConflictError);
  });

  it("rejects identity, shape, and non-string changes after sanitization", () => {
    const authoritative = semanticFixture();
    const sanitized = structuredClone(authoritative);
    sanitized[0]!.content.summaryText = "[PERSON_1] prefers morning calls.";
    expect(() =>
      validateSharedMemorySemanticSanitizedReconstruction(
        authoritative,
        sanitized
      )
    ).not.toThrow();

    const changed = structuredClone(sanitized);
    changed[0]!.sourceId = randomUUID();
    expect(() =>
      validateSharedMemorySemanticSanitizedReconstruction(
        authoritative,
        changed
      )
    ).toThrow(SharedMemoryConflictError);
  });
});
