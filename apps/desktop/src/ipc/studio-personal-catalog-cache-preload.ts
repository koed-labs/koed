import {
  parseStudioPersonalCatalogCacheRequest,
  parseStudioPersonalCatalogCacheResult,
  studioPersonalCatalogCacheCommandChannel
} from "./studio-personal-catalog-cache-protocol.js";

export type StudioPersonalCatalogCacheInvoke = (
  channel: string,
  value: unknown
) => Promise<unknown>;

export const createStudioPersonalCatalogCachePreloadApi = (
  invoke: StudioPersonalCatalogCacheInvoke
) => {
  const invokeFor = async (request: unknown, expected: string) => {
    const result = parseStudioPersonalCatalogCacheResult(
      await invoke(
        studioPersonalCatalogCacheCommandChannel,
        parseStudioPersonalCatalogCacheRequest(request)
      )
    );
    if (result.operation !== expected) {
      throw new Error(
        "Invalid Studio Personal catalog cache operation correlation."
      );
    }
    return result;
  };

  return Object.freeze({
    read: async (input: { ownerId: string; scopeKey: string }) => {
      const result = await invokeFor({ operation: "read", ...input }, "read");
      return result.operation === "read" ? result.value : null;
    },
    write: async (input: {
      ownerId: string;
      scopeKey: string;
      value: string;
    }) => {
      await invokeFor({ operation: "write", ...input }, "write");
    },
    delete: async (input: { ownerId: string; scopeKey: string }) => {
      await invokeFor({ operation: "delete", ...input }, "delete");
    }
  });
};
