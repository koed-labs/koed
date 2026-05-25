import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureMessageEvent, captureToolEvent, type CaptureRuntimeState } from "./capture.js";
import { loadConfig } from "./config.js";
import { KoedApiClient } from "./koed-client.js";
import { startPiLcmSummaryService } from "./lcm-summary.js";
import { ensureKoedSessionState } from "./session-state.js";
import { createKoedTools } from "./tools.js";
import { clip, flattenContent } from "./utils.js";

const modelLabel = (model?: { provider: string; id: string }): string | undefined =>
  model ? `${model.provider}/${model.id}` : undefined;

const koedStatus = (config: { captureEnabled: boolean; apiToken?: string }): string => {
  if (!config.apiToken) {
    return "koed token-missing";
  }
  return config.captureEnabled ? "koed on" : "koed off";
};

const setKoedErrorStatus = (ctx: {
  hasUI: boolean;
  ui: {
    setStatus(id: string, text: string): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}, message: string): void => {
  try {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setStatus("koed", "koed error");
    ctx.ui.notify(message, "warning");
  } catch {
    // Ignore stale-ui updates during shutdown in print mode.
  }
};

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const client = new KoedApiClient({
    apiUrl: config.apiUrl,
    apiToken: config.apiToken
  });
  const lcmSummaryService = startPiLcmSummaryService(client, {
    enabled: config.lcmSummaryEnabled
  });

  let runtimeState: CaptureRuntimeState | undefined;

  for (const tool of createKoedTools({
    client,
    config,
    getRuntimeState: () => runtimeState,
    getLcmSummaryService: () => lcmSummaryService
  })) {
    pi.registerTool(tool);
  }

  pi.on("session_start", async (event, ctx) => {
    const forceNew = event.reason === "new" || event.reason === "fork";
    const session = ensureKoedSessionState(pi, ctx, forceNew);
    runtimeState = {
      externalSessionId: session.externalSessionId,
      backendSessionRegistered: false
    };
    lcmSummaryService?.setCwd(ctx.cwd);
    if (ctx.hasUI) {
      ctx.ui.setStatus("koed", koedStatus(config));
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!config.captureEnabled || !runtimeState) {
      return;
    }
    if (event.message.role !== "user" && event.message.role !== "assistant") {
      return;
    }

    const content = clip(flattenContent(event.message.content));
    if (!content.trim()) {
      return;
    }

    try {
      await captureMessageEvent(
        client,
        runtimeState,
        {
          actor: event.message.role,
          eventType:
            event.message.role === "user"
              ? "pi_user_message"
              : "pi_assistant_message",
          content,
          metadata: {
            model: modelLabel(ctx.model)
          }
        },
        {
          cwd: ctx.cwd,
          model: ctx.model
        },
        ctx.signal
      );
      lcmSummaryService?.nudge(ctx.cwd);
    } catch (error) {
      setKoedErrorStatus(
        ctx,
        `Koed capture failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!config.captureEnabled || !config.captureToolEvents || !runtimeState) {
      return;
    }

    try {
      await captureToolEvent(
        client,
        runtimeState,
        {
          toolName: event.toolName,
          content: clip(JSON.stringify(event.result)),
          isError: event.isError
        },
        {
          cwd: ctx.cwd,
          model: ctx.model
        },
        ctx.signal
      );
      lcmSummaryService?.nudge(ctx.cwd);
    } catch (error) {
      setKoedErrorStatus(
        ctx,
        `Koed tool capture failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}
