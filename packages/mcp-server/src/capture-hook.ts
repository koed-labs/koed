#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  observeCaptureFolder,
  pinSourceFolderObservation,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { isConversationDirectory } from "./conversation-directory.js";

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

export interface CaptureHookMetadata {
  sessionStartSource?: string;
  hookEventName?: string;
  sourceSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

const readRoutingMetadata = async (): Promise<CaptureHookMetadata> => {
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
      ...(typeof payload.source === "string"
        ? { sessionStartSource: payload.source }
        : {}),
      ...(typeof payload.hook_event_name === "string"
        ? { hookEventName: payload.hook_event_name }
        : {}),
      ...(typeof payload.session_id === "string"
        ? { sourceSessionId: payload.session_id }
        : {}),
      ...(typeof payload.transcript_path === "string"
        ? { transcriptPath: payload.transcript_path }
        : {}),
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof payload.tool_name === "string"
        ? { toolName: payload.tool_name }
        : {}),
      ...(payload.tool_input &&
      typeof payload.tool_input === "object" &&
      !Array.isArray(payload.tool_input)
        ? { toolInput: payload.tool_input as Record<string, unknown> }
        : {})
    };
  } catch {
    return {};
  }
};

/** Native hooks supply the Conversation directory before each recall call. */
export const recallHookOutput = (
  metadata: CaptureHookMetadata,
  memoryTool = "mcp__koed__memory_answer",
  source: "codex" | "claude" = "codex"
): Record<string, unknown> => {
  if (
    metadata.hookEventName !== "PreToolUse" ||
    metadata.toolName !== memoryTool ||
    !metadata.toolInput
  )
    return {};
  if (!isConversationDirectory(metadata.cwd))
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Koed recall requires the current Conversation directory. Repair the AI Client integration and reconnect before retrying recall."
      }
    };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // Codex requires allow with updatedInput. Claude can rewrite arguments
      // without an approval decision, preserving its normal permission flow.
      ...(source === "codex" ? { permissionDecision: "allow" } : {}),
      updatedInput: { ...metadata.toolInput, conversation_cwd: metadata.cwd }
    }
  };
};

export const signalCaptureHook = (
  environment: NodeJS.ProcessEnv = process.env,
  metadata: CaptureHookMetadata = {},
  args: string[] = process.argv.slice(2)
): void => {
  if (metadata.hookEventName === "PreToolUse") return;
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

export const recordCaptureHookFolder = async (
  environment: NodeJS.ProcessEnv,
  metadata: CaptureHookMetadata,
  args: string[]
): Promise<void> => {
  if (metadata.sourceSessionId) {
    const paths = resolveKoedServerPaths(environment);
    const sourceFlag = args.indexOf("--source");
    const sourceKind =
      args.includes("--source=claude") || args[sourceFlag + 1] === "claude"
        ? ("claude-code" as const)
        : ("codex" as const);
    const observation = metadata.cwd
      ? await observeCaptureFolder(paths, metadata.cwd, environment)
      : undefined;
    pinSourceFolderObservation(
      paths,
      { sourceKind, externalSessionId: metadata.sourceSessionId },
      observation,
      metadata.hookEventName === "SessionStart" &&
        metadata.sessionStartSource === "startup"
    );
  }
};

const main = async (): Promise<void> => {
  const metadata = await readRoutingMetadata();
  const args = process.argv.slice(2);
  if (metadata.hookEventName === "PreToolUse") {
    const toolFlag = args.indexOf("--memory-tool");
    const sourceFlag = args.indexOf("--source");
    const source =
      args.includes("--source=claude") || args[sourceFlag + 1] === "claude"
        ? "claude"
        : "codex";
    process.stdout.write(
      JSON.stringify(
        recallHookOutput(
          metadata,
          toolFlag < 0 ? undefined : args[toolFlag + 1],
          source
        )
      )
    );
    return;
  }
  const environment = captureHookEnvironment();
  await recordCaptureHookFolder(environment, metadata, args);
  signalCaptureHook(environment, metadata, args);
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
