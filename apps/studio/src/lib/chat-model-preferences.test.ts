// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  loadChatModelPreference,
  readChatModelPreference,
  saveChatModelPreference
} from "./chat-model-preferences";
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});
it("remembers the exact client model and reasoning for another new chat", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ csrfToken: "token" })
    })
  );
  const value = { modelKey: "codex:gpt-6.1-sol:local", effort: "high" };
  saveChatModelPreference(value);
  expect(await loadChatModelPreference()).toEqual(value);
});
it("loads durable defaults when a restarted app has a fresh origin", async () => {
  const value = { modelKey: "claude:opus", effort: "medium" };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ preference: value })
    })
  );
  expect(await loadChatModelPreference()).toEqual(value);
});
it("ignores malformed or unavailable defaults", async () => {
  window.localStorage.setItem("koed:chat:last-model-reasoning:v1", "bad json");
  expect(readChatModelPreference()).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await loadChatModelPreference()).toBeNull();
});
