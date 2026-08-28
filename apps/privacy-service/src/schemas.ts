import {
  privacyClassificationRequestSchema,
  type PrivacyClassificationRequest
} from "@koed/shared";
import type { PrivacyServiceConfig } from "./config.js";
import { HttpError } from "./errors.js";

export const validateClassifyRequest = (
  payload: unknown,
  config: Pick<
    PrivacyServiceConfig,
    "maxFields" | "maxFieldBytes" | "maxRequestFieldBytes"
  >
): PrivacyClassificationRequest => {
  const parsed = privacyClassificationRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HttpError(
      422,
      "request body does not match the privacy classification contract",
      "invalid_schema"
    );
  }
  if (parsed.data.fields.length > config.maxFields) {
    throw new HttpError(
      413,
      `fields exceeds maximum of ${config.maxFields}`,
      "request_too_large"
    );
  }

  let totalBytes = 0;
  for (const [index, field] of parsed.data.fields.entries()) {
    const fieldBytes = Buffer.byteLength(field.text, "utf8");
    if (fieldBytes > config.maxFieldBytes) {
      throw new HttpError(
        413,
        `fields[${index}].text exceeds UTF-8 byte limit`,
        "request_too_large"
      );
    }
    totalBytes += fieldBytes;
  }
  if (totalBytes > config.maxRequestFieldBytes) {
    throw new HttpError(
      413,
      "request text exceeds total UTF-8 byte limit",
      "request_too_large"
    );
  }
  return parsed.data;
};
