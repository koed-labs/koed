import {
  sharingChannel,
  sharingRequestSchema,
  sharingResultSchema,
  type SharingDesktopApi
} from "./sharing-protocol.js";

export const createSharingPreloadApi = (
  invoke: (channel: string, request: { operation: "read" }) => Promise<unknown>
): SharingDesktopApi =>
  Object.freeze({
    read: async () =>
      sharingResultSchema.parse(
        await invoke(
          sharingChannel,
          sharingRequestSchema.parse({ operation: "read" })
        )
      )
  });
