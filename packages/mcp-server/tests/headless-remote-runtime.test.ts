import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHeadlessRemoteLocalAiRuntime } from "../src/headless-remote-runtime.js";
import type { LocalAiRuntimeServiceFactory } from "../src/local-runtime-server.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("headless remote Local AI Runtime", () => {
  it("uses the shared runtime lifecycle and remote credentials without local backend services", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "koed-headless-runtime-")
    );
    directories.push(home);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const authorizationProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("Bearer remote-secret");
    const close = vi.fn(async () => {});
    const serviceFactory = vi.fn<LocalAiRuntimeServiceFactory>(
      async ({ apiClient, environment, koedHome }) => {
        expect(koedHome).toBe(home);
        expect(environment.MEMORY_API_TOKEN).toBeUndefined();
        expect(environment.MEMORY_HISTORICAL_IMPORT_ENABLED).toBe("false");
        expect(environment.KOED_HEADLESS_FUTURE_CAPTURE_ONLY).toBe("1");
        expect(environment.MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED).toBe(
          "true"
        );
        expect(environment.MEMORY_PI_TRANSCRIPT_WATCHER_ENABLED).toBe("false");
        await apiClient.accessCheck();
        return {
          executor: {
            capabilities: async () => ({ curatedMemoryIntakeAvailable: false }),
            execute: async () => ({ ok: true })
          },
          close
        };
      }
    );
    const runtime = await startHeadlessRemoteLocalAiRuntime({
      descriptor: {
        version: 1,
        backendUrl: "https://memory.example",
        credentialRef: "config/remote-mcp-credentials.json",
        harnesses: ["codex", "claude"],
        futureCaptureOnly: true
      },
      authorizationProvider,
      environment: {
        KOED_HOME: home,
        MEMORY_API_TOKEN: "local-secret",
        MEMORY_HISTORICAL_IMPORT_ENABLED: "true"
      },
      serviceFactory
    });
    try {
      expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "https://memory.example/v1/access/check"
      );
      const registration = fs.readFileSync(
        path.join(home, "run", "local-ai-runtime.json"),
        "utf8"
      );
      expect(registration).not.toContain("remote-secret");
      expect(registration).not.toContain("local-secret");
    } finally {
      await runtime.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
