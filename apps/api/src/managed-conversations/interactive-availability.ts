import type { WebTransportInteractiveStreamHandler } from "../realtime-transport/webtransport-gateway.js";

export const managedInteractiveHandlers = (
  createTerminalHandler: () => WebTransportInteractiveStreamHandler
): ReadonlyMap<"managed_terminal", WebTransportInteractiveStreamHandler> => {
  void createTerminalHandler;
  return new Map();
};
