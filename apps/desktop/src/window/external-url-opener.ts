import { dirname } from "node:path";

import { safeExternalUrl } from "./external-url.js";

export type ExternalUrlProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number }
) => Promise<void>;

export type ExternalUrlOpenerOptions = {
  environment: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
  fallback: (url: string) => Promise<unknown>;
  platform: NodeJS.Platform;
  runProcess: ExternalUrlProcessRunner;
};

const windowsUrlHandler = "/mnt/c/Windows/System32/rundll32.exe";

const isWsl = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): boolean =>
  platform === "linux" &&
  Boolean(environment.WSL_DISTRO_NAME || environment.WSL_INTEROP);

export const createExternalUrlOpener = ({
  environment,
  existsSync,
  fallback,
  platform,
  runProcess
}: ExternalUrlOpenerOptions) => {
  return async (value: string): Promise<void> => {
    const url = safeExternalUrl(value);
    if (!url) throw new Error("A supported external URL is required.");

    if (isWsl(platform, environment) && existsSync(windowsUrlHandler)) {
      try {
        await runProcess(
          windowsUrlHandler,
          ["url.dll,FileProtocolHandler", url],
          { cwd: dirname(dirname(windowsUrlHandler)), timeout: 5_000 }
        );
        return;
      } catch {
        // Continue through Electron's platform launcher.
      }
    }

    await fallback(url);
  };
};
