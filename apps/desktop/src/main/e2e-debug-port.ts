const minimumDebugPort = 1024;

export const resolveDesktopUpdateE2eDebugPort = (
  environment: NodeJS.ProcessEnv
): number | null => {
  if (environment.KOED_DESKTOP_UPDATE_E2E !== "1") return null;
  const rawPort = environment.KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT?.trim();
  if (!rawPort || !/^\d+$/.test(rawPort)) {
    throw new Error(
      "KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT must be an explicit TCP port when KOED_DESKTOP_UPDATE_E2E=1."
    );
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < minimumDebugPort || port > 65_535) {
    throw new Error(
      "KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT must be a TCP port between 1024 and 65535."
    );
  }
  return port;
};
