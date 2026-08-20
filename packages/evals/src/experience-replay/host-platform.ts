export const EXPERIENCE_REPLAY_SUPPORTED_HOST = "linux" as const;

export const assertExperienceReplayHostPlatform = (
  platform: NodeJS.Platform = process.platform
): void => {
  if (platform === EXPERIENCE_REPLAY_SUPPORTED_HOST) return;

  throw new Error(
    "Experience Replay requires a Linux host. Native Linux, WSL, and Linux containers are supported; macOS and native Windows are not yet supported."
  );
};
