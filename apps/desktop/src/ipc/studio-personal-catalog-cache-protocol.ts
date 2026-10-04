export const studioPersonalCatalogCacheCommandChannel =
  "koed:studio-personal-catalog-cache:command";

export type StudioPersonalCatalogCacheRequest =
  | { operation: "read"; ownerId: string; scopeKey: string }
  | {
      operation: "write";
      ownerId: string;
      scopeKey: string;
      value: string;
    }
  | { operation: "delete"; ownerId: string; scopeKey: string };

export type StudioPersonalCatalogCacheResult =
  | { operation: "read"; value: string | null }
  | { operation: "write" | "delete"; ok: true };

const validIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024;

export const parseStudioPersonalCatalogCacheRequest = (
  value: unknown
): StudioPersonalCatalogCacheRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Studio Personal catalog cache request.");
  }
  const request = value as Record<string, unknown>;
  if (!validIdentity(request.ownerId) || !validIdentity(request.scopeKey)) {
    throw new Error("Invalid Studio Personal catalog cache identity.");
  }
  if (request.operation === "read" || request.operation === "delete") {
    return {
      operation: request.operation,
      ownerId: request.ownerId,
      scopeKey: request.scopeKey
    };
  }
  if (
    request.operation === "write" &&
    typeof request.value === "string" &&
    new TextEncoder().encode(request.value).byteLength <= 1_000_000
  ) {
    return {
      operation: "write",
      ownerId: request.ownerId,
      scopeKey: request.scopeKey,
      value: request.value
    };
  }
  throw new Error("Invalid Studio Personal catalog cache operation.");
};

export const parseStudioPersonalCatalogCacheResult = (
  value: unknown
): StudioPersonalCatalogCacheResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Studio Personal catalog cache response.");
  }
  const result = value as Record<string, unknown>;
  if (
    result.operation === "read" &&
    (result.value === null || typeof result.value === "string") &&
    (result.value === null ||
      new TextEncoder().encode(result.value).byteLength <= 1_000_000)
  ) {
    return { operation: "read", value: result.value as string | null };
  }
  if (
    (result.operation === "write" || result.operation === "delete") &&
    result.ok === true
  ) {
    return { operation: result.operation, ok: true };
  }
  throw new Error("Invalid Studio Personal catalog cache response.");
};
