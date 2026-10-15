import { describe, expect, it } from "vitest";
import {
  syncProfileTransitionRequestSchema,
  syncProfileTransitionReceiptSchema
} from "./cross-identity-sync-profile-transition.js";
const request = {
  protocol: "koed.captured-session-sync/profile-transition/v1" as const,
  relationshipId: "11111111-1111-4111-8111-111111111111",
  packageId: "22222222-2222-4222-8222-222222222222",
  sourceSequence: 3,
  fromCursor: 4,
  toCursor: 9,
  requestHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  packageChecksum: "c".repeat(64)
};
const receipt = {
  request,
  outcome: "superseded" as const,
  sourceCursor: 4,
  targetProcessingCursor: 4,
  packageSequence: 3,
  issuedAt: "2026-10-15T00:00:00.000Z"
};
describe("Directed Sync profile transition control contract", () => {
  it("binds retirement to an unused sequence without advancing its data cursor", () => {
    expect(syncProfileTransitionReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      syncProfileTransitionReceiptSchema.safeParse({
        ...receipt,
        targetProcessingCursor: 9,
        sourceCursor: 9
      }).success
    ).toBe(false);
  });
  it("binds an applied receipt to the completed upload cursor", () => {
    expect(
      syncProfileTransitionReceiptSchema.parse({
        ...receipt,
        outcome: "applied",
        sourceCursor: 9,
        targetProcessingCursor: 9
      }).outcome
    ).toBe("applied");
    expect(
      syncProfileTransitionReceiptSchema.safeParse({
        ...receipt,
        outcome: "applied"
      }).success
    ).toBe(false);
  });
  it.each([
    { sourceSequence: 0 },
    { toCursor: 3 },
    { manifestHash: "invalid" },
    { encryptedPackage: {} },
    { formatVersion: 1 }
  ])("rejects invalid or body-bearing transition metadata %j", (change) => {
    expect(
      syncProfileTransitionRequestSchema.safeParse({ ...request, ...change })
        .success
    ).toBe(false);
  });
  it("rejects a receipt for another sequence or a regressed source cursor", () => {
    expect(
      syncProfileTransitionReceiptSchema.safeParse({
        ...receipt,
        packageSequence: 4
      }).success
    ).toBe(false);
    expect(
      syncProfileTransitionReceiptSchema.safeParse({
        ...receipt,
        sourceCursor: 3
      }).success
    ).toBe(false);
  });
});
