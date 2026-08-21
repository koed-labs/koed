import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./errors.js";

export const requirePrivacyToken = (
  expected: string,
  supplied: string | null
): void => {
  if (!expected) {
    throw new HttpError(
      503,
      "privacy service authentication is not configured",
      "auth_not_configured"
    );
  }
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied ?? "");
  const valid =
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes);
  if (!valid) {
    throw new HttpError(401, "invalid privacy service token", "unauthorized");
  }
};
