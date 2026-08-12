#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import { signalCodexTranscriptWatcher } from "./codex-transcript-watcher-signal.js";
import { signalClaudeTranscriptWatcher } from "./claude-transcript-watcher-signal.js";

export const captureHookEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2)
): NodeJS.ProcessEnv => {
  const koedHomeFlag = args.indexOf("--koed-home");
  const koedHome = koedHomeFlag >= 0 ? args[koedHomeFlag + 1]?.trim() : "";
  return koedHome
    ? { ...environment, KOED_HOME: path.resolve(koedHome) }
    : environment;
};

const readRoutingMetadata = async (): Promise<{
  hookEventName?: string;
  sourceSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}> => {
  let encoded = "";
  for await (const chunk of process.stdin) {
    if (encoded.length <= 16 * 1024 * 1024) {
      encoded += Buffer.from(chunk as Uint8Array).toString("utf8");
    }
  }
  if (encoded.length > 16 * 1024 * 1024) return {};
  try {
    const payload = JSON.parse(encoded) as Record<string, unknown>;
    return {
      ...(typeof payload.hook_event_name === "string"
        ? { hookEventName: payload.hook_event_name }
        : {}),
      ...(typeof payload.session_id === "string"
        ? { sourceSessionId: payload.session_id }
        : {}),
      ...(typeof payload.transcript_path === "string"
        ? { transcriptPath: payload.transcript_path }
        : {}),
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {})
    };
  } catch {
    return {};
  }
};

export const signalCaptureHook = (
  environment: NodeJS.ProcessEnv = process.env,
  metadata: {
    hookEventName?: string;
    sourceSessionId?: string;
    transcriptPath?: string;
    cwd?: string;
  } = {},
  args: string[] = process.argv.slice(2)
): void => {
  const sourceFlag = args.indexOf("--source");
  const source =
    args
      .find((argument) => argument.startsWith("--source="))
      ?.slice("--source=".length) ??
    (sourceFlag >= 0 ? args[sourceFlag + 1] : undefined);
  if (source === "claude") {
    if (metadata.sourceSessionId && metadata.transcriptPath && metadata.cwd) {
      signalClaudeTranscriptWatcher(environment, {
        sourceSessionId: metadata.sourceSessionId,
        transcriptPath: metadata.transcriptPath,
        cwd: metadata.cwd,
        hookEventName: metadata.hookEventName,
        turnBoundary:
          metadata.hookEventName === "Stop" ||
          metadata.hookEventName === "StopFailure" ||
          metadata.hookEventName === "SessionEnd"
      });
    }
    return;
  }
  signalCodexTranscriptWatcher(environment, {
    sourceSessionId: metadata.sourceSessionId,
    transcriptPath: metadata.transcriptPath,
    turnBoundary:
      metadata.hookEventName === "Stop" ||
      metadata.hookEventName === "SubagentStop"
  });
};

const main = async (): Promise<void> => {
  signalCaptureHook(
    captureHookEnvironment(),
    await readRoutingMetadata(),
    process.argv.slice(2)
  );
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `koed capture hook failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(0);
  });
}
