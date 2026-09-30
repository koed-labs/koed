import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query
}));

import { aiClientDriverFor } from "../src/ai-client-runner.js";

it("publishes versioned SDK labels without replacing Claude model aliases", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "koed-claude-catalog-"));
  const executable = path.join(home, "claude");
  fs.writeFileSync(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo '2.1.282 (Claude Code)'
else
  echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
fi
`,
    { mode: 0o700 }
  );
  const close = vi.fn();
  sdk.query.mockReturnValue({
    supportedModels: async () => [
      { value: "sonnet", displayName: "Sonnet 5.5", description: "Sonnet" },
      { value: "opus", displayName: "Opus 5.5", description: "Opus" }
    ],
    close
  });
  try {
    const discovery = await aiClientDriverFor("claude").discover({
      instanceId: "claude.fixture",
      configIdentityHash: "a".repeat(64),
      environment: { HOME: home, KOED_CLAUDE_CODE_EXECUTABLE: executable }
    });
    expect(discovery.authenticationState).toBe("authenticated");
    expect(discovery.models).toEqual([
      expect.objectContaining({
        id: "sonnet",
        model: "sonnet",
        displayName: "Sonnet 5.5"
      }),
      expect.objectContaining({
        id: "opus",
        model: "opus",
        displayName: "Opus 5.5"
      })
    ]);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    sdk.query.mockReset();
  }
});
