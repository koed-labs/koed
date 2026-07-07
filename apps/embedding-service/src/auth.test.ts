import { describe, expect, it } from "vitest";
import {
  HttpError,
  embeddingTokenAuthStatus,
  requireInternalToken
} from "./auth.js";

describe("Embedding Service auth", () => {
  it("treats blank configured tokens as disabled", () => {
    expect(
      embeddingTokenAuthStatus({ embeddingServiceToken: "" }, null)
    ).toEqual({ authRequired: false, authValid: true });
  });

  it("validates configured tokens", () => {
    expect(
      embeddingTokenAuthStatus({ embeddingServiceToken: "secret" }, "secret")
    ).toEqual({ authRequired: true, authValid: true });
    expect(
      embeddingTokenAuthStatus({ embeddingServiceToken: "secret" }, "wrong")
    ).toEqual({ authRequired: true, authValid: false });
  });

  it("rejects invalid internal tokens", () => {
    expect(() =>
      requireInternalToken({ embeddingServiceToken: "secret" }, "wrong")
    ).toThrow(HttpError);
  });
});
