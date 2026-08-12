export const shouldQuitAfterAllWindowsClosed = (
  platform: NodeJS.Platform
): boolean => platform !== "darwin" && platform !== "linux";
