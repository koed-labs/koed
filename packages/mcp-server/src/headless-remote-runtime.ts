import { defaultConfig } from "./index.js";
import {
  startLocalAiRuntime,
  type LocalAiRuntimeHandle,
  type LocalAiRuntimeServiceFactory
} from "./local-runtime-server.js";

export interface HeadlessRemoteRuntimeDescriptor {
  version: 1;
  backendUrl: string;
  credentialRef: "config/remote-mcp-credentials.json";
  harnesses: Array<"codex" | "claude" | "pi">;
  futureCaptureOnly: true;
}

// The caller validates the descriptor and owns credential storage and renewal.
export const startHeadlessRemoteLocalAiRuntime = async ({
  descriptor,
  authorizationProvider,
  environment = process.env,
  serviceFactory
}: {
  descriptor: HeadlessRemoteRuntimeDescriptor;
  authorizationProvider: () => Promise<string>;
  environment?: NodeJS.ProcessEnv;
  serviceFactory?: LocalAiRuntimeServiceFactory;
}): Promise<LocalAiRuntimeHandle> => {
  const remoteEnvironment = {
    ...environment,
    MEMORY_API_URL: descriptor.backendUrl,
    MEMORY_API_TOKEN: undefined,
    MEMORY_HISTORICAL_IMPORT_ENABLED: "false",
    KOED_HEADLESS_FUTURE_CAPTURE_ONLY: "1",
    MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: String(
      descriptor.harnesses.includes("codex")
    ),
    MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: String(
      descriptor.harnesses.includes("claude")
    ),
    MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED: String(
      descriptor.harnesses.includes("pi")
    )
  };
  return startLocalAiRuntime({
    environment: remoteEnvironment,
    config: {
      ...defaultConfig(remoteEnvironment),
      apiUrl: descriptor.backendUrl,
      apiToken: undefined,
      authorizationProvider
    },
    serviceFactory
  });
};
