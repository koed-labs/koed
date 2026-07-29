import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { useCallback, useSyncExternalStore } from "react";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";

const subscribeToClient = (
  client: CollaborationRendererClient,
  notify: () => void
): (() => void) =>
  client.subscribe(() => {
    notify();
  });

export const useCollaborationSnapshot = (
  client: CollaborationRendererClient
): CollaborationSnapshot | null => {
  const subscribe = useCallback(
    (notify: () => void) => subscribeToClient(client, notify),
    [client]
  );
  const getSnapshot = useCallback(() => client.current(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
