import type { AiClient } from "./types";

export const selectedThreadStorageKey = "koed_explorer_browser_thread_id";
export const tokenStorageKey = "koed_explorer_browser_api_token";
export const clientStorageKey = "koed_explorer_browser_ai_client";
export const manualMemoryAgentStorageKey =
  "koed_explorer_browser_manual_memory_agent";

export function readConfiguredToken() {
  return (
    window.localStorage.getItem(tokenStorageKey) ??
    import.meta.env.VITE_KOED_API_TOKEN ??
    ""
  );
}

export function readConfiguredClient(): AiClient {
  const value = window.localStorage.getItem(clientStorageKey);
  return value === "codex" ? value : "codex";
}

export function readConfiguredAnswerBridgeUrl() {
  return (
    import.meta.env.VITE_KOED_ANSWER_BRIDGE_URL ?? "http://localhost:3210"
  ).replace(/\/$/, "");
}
