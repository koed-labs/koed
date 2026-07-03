import type { AiClient } from "./types";

export const selectedThreadStorageKey = "koed_explorer_browser_thread_id";
export const tokenStorageKey = "koed_explorer_browser_api_token";
export const clientStorageKey = "koed_explorer_browser_ai_client";
export const manualMemoryAgentStorageKey =
  "koed_explorer_browser_manual_memory_agent";

const usableToken = (value: string | undefined | null): string | null => {
  const token = value?.trim();
  if (!token || token.includes("replace_with_token")) {
    return null;
  }
  return token;
};

const isDesktopEmbed = (): boolean =>
  new URLSearchParams(window.location.search).get("koedDesktop") === "1";

export function readConfiguredToken() {
  const storedToken = usableToken(window.localStorage.getItem(tokenStorageKey));
  const provisionedToken = usableToken(import.meta.env.VITE_KOED_API_TOKEN);
  const desktopToken = usableToken(
    new URLSearchParams(window.location.search).get("koedApiToken")
  );

  if (isDesktopEmbed()) {
    const token = desktopToken ?? provisionedToken;
    if (token) {
      if (storedToken !== token) {
        window.localStorage.setItem(tokenStorageKey, token);
      }
      return token;
    }
  }

  return storedToken ?? provisionedToken ?? "";
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
