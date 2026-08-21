import { createHash, randomUUID } from "node:crypto";
import {
  PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
  privacyClassificationResponseSchema,
  type PrivacyClassificationResponse
} from "@koed/shared";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { requirePrivacyToken } from "./auth.js";
import type { PrivacyServiceConfig } from "./config.js";
import { ClassificationError, HttpError } from "./errors.js";
import { PRIVACY_LABELS } from "./labels.js";
import { maskClassification } from "./masking.js";
import { parsePrivacyRuntimePreference } from "./provider.js";
import {
  PrivacyProviderSwitchError,
  type PrivacyRuntimeManager
} from "./runtime-manager.js";
import type { PrivacyRuntimeAdapter } from "./runtime.js";
import { validateClassifyRequest } from "./schemas.js";

export interface PrivacyService {
  handle(request: Request): Promise<Response>;
}

type ManagedPrivacyRuntime = PrivacyRuntimeAdapter &
  Pick<
    PrivacyRuntimeManager,
    "status" | "switchProvider" | "refreshAcceleratorObservation"
  >;

const isManagedRuntime = (
  runtime: PrivacyRuntimeAdapter
): runtime is ManagedPrivacyRuntime =>
  "status" in runtime &&
  typeof runtime.status === "function" &&
  "switchProvider" in runtime &&
  typeof runtime.switchProvider === "function" &&
  "refreshAcceleratorObservation" in runtime &&
  typeof runtime.refreshAcceleratorObservation === "function";

const jsonResponse = (
  body: unknown,
  status: number,
  requestId: string
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "cache-control": "no-store"
    }
  });

const requestIdFor = (request: Request): string => {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : randomUUID();
};

const parseBody = async (
  request: Request,
  maxBodyBytes: number
): Promise<unknown> => {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(
      415,
      "content-type must be application/json",
      "unsupported_media_type"
    );
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new HttpError(
      413,
      "request body exceeds byte limit",
      "request_too_large"
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBodyBytes) {
    throw new HttpError(
      413,
      "request body exceeds byte limit",
      "request_too_large"
    );
  }
  if (!text.trim()) {
    throw new HttpError(422, "request body must contain JSON", "invalid_json");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(422, "request body must be valid JSON", "invalid_json");
  }
};

const parseProviderControl = (
  value: unknown
): ReturnType<typeof parsePrivacyRuntimePreference> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("provider" in value) ||
    typeof value.provider !== "string"
  ) {
    throw new HttpError(
      422,
      "provider control requires exactly one provider field",
      "invalid_provider_control"
    );
  }
  try {
    return parsePrivacyRuntimePreference(value.provider);
  } catch {
    throw new HttpError(
      422,
      "provider is not supported",
      "invalid_provider_control"
    );
  }
};

export const createPrivacyService = (
  config: PrivacyServiceConfig,
  runtime: PrivacyRuntimeAdapter
): PrivacyService => ({
  async handle(request: Request): Promise<Response> {
    const requestId = requestIdFor(request);
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        const runtimeStatus = isManagedRuntime(runtime)
          ? runtime.status()
          : undefined;
        return jsonResponse(
          {
            status: runtime.isReady() ? "ok" : "loading",
            schemaVersion: 1,
            classifier: {
              modelId: runtime.modelId,
              modelRevision: runtime.modelRevision,
              classifierHash: runtime.classifierHash
            },
            labels: PRIVACY_LABELS,
            runtime: runtimeStatus
              ? {
                  component: runtimeStatus.component,
                  requestedProvider: runtimeStatus.requestedProvider,
                  activeProvider: runtimeStatus.activeProvider,
                  switchState: runtimeStatus.switchState
                }
              : {
                  component: "privacy_filter",
                  activeProvider: runtime.provider
                }
          },
          runtime.isReady() ? 200 : 503,
          requestId
        );
      }
      if (url.pathname === "/v1/runtime/status") {
        requirePrivacyToken(
          config.controlToken,
          request.headers.get("x-koed-privacy-token")
        );
        if (request.method !== "GET" || !isManagedRuntime(runtime)) {
          throw new HttpError(404, "route not found", "not_found");
        }
        return jsonResponse(
          await runtime.refreshAcceleratorObservation(),
          200,
          requestId
        );
      }
      if (url.pathname === "/v1/runtime/provider") {
        requirePrivacyToken(
          config.controlToken,
          request.headers.get("x-koed-privacy-token")
        );
        if (request.method !== "POST" || !isManagedRuntime(runtime)) {
          throw new HttpError(404, "route not found", "not_found");
        }
        const provider = parseProviderControl(
          await parseBody(request, config.maxBodyBytes)
        );
        return jsonResponse(
          await runtime.switchProvider(provider),
          200,
          requestId
        );
      }
      if (request.method !== "POST" || url.pathname !== "/v1/classify") {
        throw new HttpError(404, "route not found", "not_found");
      }

      requirePrivacyToken(
        config.token,
        request.headers.get("x-koed-privacy-token")
      );
      const input = validateClassifyRequest(
        await parseBody(request, config.maxBodyBytes),
        config
      );
      const fields = [];
      for (const field of input.fields) {
        const classified = maskClassification(
          field.text,
          await runtime.classify(field.text)
        );
        fields.push({
          path: field.path,
          inputSha256: createHash("sha256").update(field.text).digest("hex"),
          inputByteLength: Buffer.byteLength(field.text, "utf8"),
          ...classified,
          decodedTextMatchesInput: true as const
        });
      }
      const response: PrivacyClassificationResponse = {
        schemaVersion: 1,
        inputContractVersion: PRIVACY_CLASSIFICATION_CONTRACT_VERSION,
        classifier: {
          modelKey: runtime.modelId,
          modelRevision: runtime.modelRevision,
          classifierHash: runtime.classifierHash
        },
        fields
      };
      return jsonResponse(
        privacyClassificationResponseSchema.parse(response),
        200,
        requestId
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(
          { error: { code: error.code, detail: error.detail } },
          error.statusCode,
          requestId
        );
      }
      if (error instanceof ClassificationError) {
        return jsonResponse(
          {
            error: {
              code: "classification_failed",
              detail: "privacy classification output could not be validated"
            }
          },
          503,
          requestId
        );
      }
      if (error instanceof PrivacyProviderSwitchError) {
        return jsonResponse(
          {
            error: {
              code: error.code,
              detail: "privacy runtime provider could not be activated",
              provider: error.provider
            }
          },
          409,
          requestId
        );
      }
      return jsonResponse(
        {
          error: {
            code: "internal_error",
            detail: "privacy classification failed"
          }
        },
        500,
        requestId
      );
    }
  }
});

const readBody = async (
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxBodyBytes) {
      throw new HttpError(
        413,
        "request body exceeds byte limit",
        "request_too_large"
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const writeResponse = async (
  response: ServerResponse,
  result: Response
): Promise<void> => {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await result.arrayBuffer()));
};

export const createNodeHttpServer = (
  service: PrivacyService,
  maxBodyBytes: number
): Server =>
  createServer((request, response) => {
    void (async () => {
      try {
        const host = request.headers.host ?? "127.0.0.1";
        const body =
          request.method === "POST"
            ? await readBody(request, maxBodyBytes)
            : undefined;
        const webRequest = new Request(`http://${host}${request.url ?? "/"}`, {
          method: request.method,
          headers: request.headers as HeadersInit,
          body: body ? new Uint8Array(body) : undefined
        });
        await writeResponse(response, await service.handle(webRequest));
      } catch (error) {
        const status = error instanceof HttpError ? error.statusCode : 500;
        const code = error instanceof HttpError ? error.code : "internal_error";
        response.statusCode = status;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(
          JSON.stringify({ error: { code, detail: "request failed" } })
        );
      }
    })();
  });

export const listenNodeHttpServer = (
  server: Server,
  host: string,
  port: number
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
