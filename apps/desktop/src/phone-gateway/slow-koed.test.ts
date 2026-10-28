/**
 * On a real Mac some Koed reads take many seconds (the AI Client list, plan
 * usage, every job's run history). The phone's home screen must still answer
 * quickly, filling in the slow parts on the next read.
 */
import { describe, expect, it } from "vitest";
import { createFakeKoed } from "./fake-koed.testkit.js";
import { createGamificationStore } from "./gamification.js";
import { createPhoneGatewayService, type PhoneGatewayDeps } from "./service.js";
import { createPhoneGatewayStore } from "./store.js";

const slow = <T extends (...args: any[]) => Promise<any>>(
  fn: T,
  ms: number
): T =>
  (async (...args: any[]) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return fn(...args);
  }) as T;

describe("phone gateway on a slow Koed", () => {
  it("answers home within a few seconds and fills in the rest later", async () => {
    const koed = createFakeKoed();
    const deps: PhoneGatewayDeps = {
      ...koed.deps,
      localAiClients: slow(koed.deps.localAiClients, 12_000),
      scheduledJobs: slow(koed.deps.scheduledJobs, 2_500),
      personalMemory: slow(koed.deps.personalMemory, 5_000)
    };
    const secrets = new Map<string, string>();
    const secretStore = {
      get: async (key: string) => secrets.get(key) ?? null,
      put: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key)
    };
    const service = createPhoneGatewayService(
      deps,
      createPhoneGatewayStore(secretStore),
      createGamificationStore(secretStore)
    );
    const started = Date.now();
    const first = await service.home();
    const took = Date.now() - started;
    expect(took).toBeLessThan(7_000);
    expect(first.chief?.name).toBe("Cooper");
    // Approvals come from the running Chats, which answer quickly: they're there at once.
    expect(first.needs.some((need) => need.kind === "approval")).toBe(true);
    expect(first.timing?.total).toBeGreaterThan(1_500);
    // Once the slow reads have landed, home has everything, quickly.
    await new Promise((resolve) => setTimeout(resolve, 13_000));
    const again = Date.now();
    const second = await service.home();
    expect(Date.now() - again).toBeLessThan(1_500);
    expect(second.upcoming.map((entry) => entry.title)).toContain(
      "Morning brief"
    );
    expect(second.chief?.aiClientName).toBe("Claude Code");
  }, 30_000);
});
