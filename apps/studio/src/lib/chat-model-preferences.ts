import { loadStudioCsrfToken } from "./studio-csrf";
export type ChatModelPreference = { modelKey: string; effort: string };
const KEY = "koed:chat:last-model-reasoning:v1";
export function readChatModelPreference(): ChatModelPreference | null {
  try {
    if (typeof window === "undefined") return null;
    const value: unknown = JSON.parse(
      window.localStorage.getItem(KEY) ?? "null"
    );
    if (!value || typeof value !== "object") return null;
    const item = value as Partial<ChatModelPreference>;
    if (
      typeof item.modelKey !== "string" ||
      !item.modelKey.trim() ||
      item.modelKey.length > 512 ||
      typeof item.effort !== "string" ||
      item.effort.length > 40
    )
      return null;
    return { modelKey: item.modelKey, effort: item.effort };
  } catch {
    return null;
  }
}
export function saveChatModelPreference(value: ChatModelPreference): void {
  void persistChatModelPreference(value);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Storage availability must not prevent sending. */
  }
}

export async function loadChatModelPreference(): Promise<ChatModelPreference | null> {
  const cached = readChatModelPreference();
  if (cached) return cached;
  if (
    typeof window === "undefined" ||
    window.location.pathname.startsWith("/studio")
  )
    return null;
  try {
    const response = await fetch("/studio-api/chat-model-preferences", {
      cache: "no-store"
    });
    if (!response.ok) return null;
    const { preference } = await response.json();
    if (
      typeof preference?.modelKey !== "string" ||
      !preference.modelKey.trim() ||
      preference.modelKey.length > 512 ||
      typeof preference.effort !== "string" ||
      preference.effort.length > 40
    )
      return null;
    return { modelKey: preference.modelKey, effort: preference.effort };
  } catch {
    return null;
  }
}
async function persistChatModelPreference(
  value: ChatModelPreference
): Promise<void> {
  if (
    typeof window === "undefined" ||
    window.location.pathname.startsWith("/studio")
  )
    return;
  try {
    const token = await loadStudioCsrfToken();
    await fetch("/studio-api/chat-model-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-studio-csrf": token },
      body: JSON.stringify(value)
    });
  } catch {
    /* Saving defaults must not block a conversation. */
  }
}
