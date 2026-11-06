import { recordAiClientConnections } from "@koed/shared/ai-client-connections";
import { defaultConfig, MemoryApiClient } from "./index.js";
import { supportsTeamMemoryAnswerTasks } from "./memory-answer-task-coordinator.js";
import {
  startLocalAiRuntime,
  type LocalAiRuntimeHandle,
  type LocalAiRuntimeServiceFactory
} from "./local-runtime-server.js";
import { resolveKoedHome } from "./local-runtime-protocol.js";

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
  serviceFactory,
  allowTeamRuntime = false
}: {
  descriptor: HeadlessRemoteRuntimeDescriptor;
  authorizationProvider: () => Promise<string>;
  environment?: NodeJS.ProcessEnv;
  serviceFactory?: LocalAiRuntimeServiceFactory;
  /** Granted by credential bootstrap after explicit Team and execution consent. */
  allowTeamRuntime?: boolean;
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
  const config = {
    ...defaultConfig(remoteEnvironment),
    apiUrl: descriptor.backendUrl,
    apiToken: undefined,
    authorizationProvider
  };
  if (
    allowTeamRuntime &&
    !supportsTeamMemoryAnswerTasks(
      await new MemoryApiClient(config).capabilities()
    )
  ) {
    throw new Error(
      "The Team Backend does not support durable Team Memory Answer tasks"
    );
  }
  // The Local AI Runtime reads only connected AI Clients. In this mode the
  // consented descriptor names them; Koed Server's status check, which records
  // connections otherwise, does not run here.
  recordAiClientConnections(resolveKoedHome(remoteEnvironment), {
    codex: descriptor.harnesses.includes("codex"),
    claude: descriptor.harnesses.includes("claude"),
    pi: descriptor.harnesses.includes("pi")
  });
  return startLocalAiRuntime({
    environment: remoteEnvironment,
    config,
    serviceFactory,
    allowTeamRuntime
  });
};
