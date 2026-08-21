import { describe, expect, it } from "vitest";
import { PRIVACY_CLASSIFICATION_CONTRACT_VERSION } from "@koed/shared";
import { validateClassifyRequest } from "./schemas.js";

const limits = { maxFields: 2, maxFieldChars: 5, maxRequestChars: 7 };
const request = (fields: Array<{ path: string; text: string }>) => ({
  schemaVersion: 1,
  inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  fields
});

describe("classification request schema", () => {
  it("accepts unique schema paths and empty strings", () => {
    expect(
      validateClassifyRequest(request([{ path: "title", text: "" }]), limits)
    ).toEqual(request([{ path: "title", text: "" }]));
  });

  it("rejects unknown properties and schema versions", () => {
    expect(() =>
      validateClassifyRequest(
        { ...request([{ path: "x", text: "x" }]), policy: "all" },
        limits
      )
    ).toThrow(/does not match/);
    expect(() =>
      validateClassifyRequest({ schemaVersion: 2, fields: [] }, limits)
    ).toThrow(/does not match/);
  });

  it("enforces field, per-field, aggregate, and duplicate-path limits", () => {
    expect(() =>
      validateClassifyRequest(
        request([
          { path: "a", text: "a" },
          { path: "b", text: "b" },
          { path: "c", text: "c" }
        ]),
        limits
      )
    ).toThrow(/maximum/);
    expect(() =>
      validateClassifyRequest(request([{ path: "a", text: "123456" }]), limits)
    ).toThrow(/character limit/);
    expect(() =>
      validateClassifyRequest(
        request([
          { path: "a", text: "1234" },
          { path: "b", text: "5678" }
        ]),
        limits
      )
    ).toThrow(/total character/);
    expect(() =>
      validateClassifyRequest(
        request([
          { path: "a", text: "1" },
          { path: "a", text: "2" }
        ]),
        limits
      )
    ).toThrow(/does not match/);
  });
});
