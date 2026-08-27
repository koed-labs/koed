import { createHash, randomUUID } from "node:crypto";
import {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  privacyClassificationRequestSchema,
  privacyClassificationResponseSchema,
  privacyServiceCapabilitiesSchema,
  type PrivacyClassificationFieldRequest,
  type PrivacyClassificationResponse,
  type PrivacyServiceCapabilities
} from "./privacy-filter-contract.js";

export class PrivacyServiceUnavailableError extends Error {
  readonly transient = true;

  constructor(message = "Privacy classification service is unavailable") {
    super(message);
    this.name = "PrivacyServiceUnavailableError";
  }
}

export class PrivacyServiceContractError extends Error {
  constructor(message = "Privacy classification response is invalid") {
    super(message);
    this.name = "PrivacyServiceContractError";
  }
}

export interface PrivacyServiceClient {
  capabilities(): Promise<PrivacyServiceCapabilities>;
  classify(
    fields: readonly PrivacyClassificationFieldRequest[]
  ): Promise<PrivacyClassificationResponse>;
}

export interface PrivacyServiceClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const normalizedBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    throw new TypeError(
      "Privacy Service URL must be a credential-free HTTP URL"
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

export const createPrivacyServiceClient = (
  options: PrivacyServiceClientOptions
): PrivacyServiceClient => {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const token = options.token.trim();
  if (!token) throw new TypeError("Privacy Service token is required");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
    throw new TypeError("Privacy Service timeout must be at least 100ms");
  }
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5
  ) {
    throw new TypeError("Privacy Service attempts must be between 1 and 5");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async capabilities() {
      try {
        const response = await fetchImpl(`${baseUrl}/v1/capabilities`, {
          method: "GET",
          headers: {
            "x-koed-privacy-token": token,
            "x-request-id": randomUUID()
          },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          throw new PrivacyServiceContractError(
            `Privacy capability request was rejected (${response.status})`
          );
        }
        const parsed = privacyServiceCapabilitiesSchema.safeParse(
          await response.json()
        );
        if (!parsed.success) throw new PrivacyServiceContractError();
        return parsed.data;
      } catch (error) {
        if (error instanceof PrivacyServiceContractError) throw error;
        throw new PrivacyServiceUnavailableError(
          error instanceof Error && error.name === "TimeoutError"
            ? "Privacy capability request timed out"
            : undefined
        );
      }
    },
    async classify(fields) {
      const request = privacyClassificationRequestSchema.parse({
        schemaVersion: 1,
        inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
        fields
      });
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${baseUrl}/v1/classify`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-koed-privacy-token": token,
              "x-request-id": randomUUID()
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (!response.ok) {
            if (!retryableStatus(response.status)) {
              throw new PrivacyServiceContractError(
                `Privacy classification request was rejected (${response.status})`
              );
            }
            throw new PrivacyServiceUnavailableError();
          }
          const parsed = privacyClassificationResponseSchema.safeParse(
            await response.json()
          );
          if (!parsed.success) throw new PrivacyServiceContractError();
          if (
            parsed.data.fields.length !== request.fields.length ||
            parsed.data.fields.some((field, index) => {
              const source = request.fields[index];
              return (
                source === undefined ||
                field.path !== source.path ||
                field.inputSha256 !== sha256(source.text) ||
                field.inputByteLength !== Buffer.byteLength(source.text, "utf8")
              );
            })
          ) {
            throw new PrivacyServiceContractError(
              "Privacy classification response does not match its request"
            );
          }
          return parsed.data;
        } catch (error) {
          if (error instanceof PrivacyServiceContractError) throw error;
          lastError = error;
          if (attempt < maxAttempts)
            await delay(Math.min(100 * 2 ** (attempt - 1), 500));
        }
      }
      throw new PrivacyServiceUnavailableError(
        lastError instanceof Error && lastError.name === "TimeoutError"
          ? "Privacy classification service timed out"
          : undefined
      );
    }
  };
};
