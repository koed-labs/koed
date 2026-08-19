import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshLocalAiRuntime } from "./local-ai-client-refresh.js";
import { localRuntimeRegistrationPath } from "./local-runtime-registration.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const runtimeHome = (): string => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-refresh-test-"));
  homes.push(home);
  const run = resolve(home, "run");
  mkdirSync(run, { mode: 0o700 });
  writeFileSync(
    localRuntimeRegistrationPath(home),
    JSON.stringify({
      protocolVersion: 1,
      url: "http://127.0.0.1:43123",
      authorization: `Bearer ${"a".repeat(43)}`,
      pid: 1234,
      startedAt: "2026-08-19T16:51:41.000Z"
    }),
    { mode: 0o600 }
  );
  return home;
};

describe("Local AI Client capability refresh", () => {
  it("rejects non-ok HTTP responses before accepting payload", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ protocolVersion: 1, publications: [] }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
    );
    await expect(
      refreshLocalAiRuntime({ fetch, koedHome: runtimeHome() })
    ).resolves.toEqual({
      refreshed: false,
      refreshError: "Capability refresh request failed."
    });
  });
});
