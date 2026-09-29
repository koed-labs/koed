import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkClaudeCodeAvailability } from "@koed/mcp-server";
import { createClaudeCommandDiscoveryAdapter } from "./command-discovery-adapter-claude.js";

vi.mock("@koed/mcp-server", () => ({
  checkCodexAppServerAvailability: vi.fn().mockResolvedValue({ available: true }),
  checkClaudeCodeAvailability: vi.fn().mockResolvedValue({ available: true }),
  checkPiAvailability: vi.fn().mockResolvedValue({ available: true })
}));

beforeEach(() => {
  vi.resetAllMocks();
});

const mockCheckClaude = vi.mocked(checkClaudeCodeAvailability);

describe("Claude command discovery adapter", () => {
  it("returns commands and skills when runtime is available", async () => {
    mockCheckClaude.mockResolvedValue({ available: true });
    const adapter = createClaudeCommandDiscoveryAdapter();
    const commands = await adapter.discoverCommands({
      aiClientDriverId: "claude",
      aiClientInstanceId: "claude.default",
      projectId: "test-project"
    });

    expect(commands.length).toBeGreaterThan(0);
    const kinds = commands.map((c) => c.kind);
    expect(kinds).toContain("command");
    expect(kinds).toContain("skill");
    expect(commands[0]).toMatchObject({
      name: "/edit",
      kind: "command",
      source: "provider"
    });
    expect(mockCheckClaude).toHaveBeenCalledOnce();
  });

  it("returns empty array when runtime is unavailable", async () => {
    mockCheckClaude.mockResolvedValue({ available: false });
    const adapter = createClaudeCommandDiscoveryAdapter();
    const commands = await adapter.discoverCommands({
      aiClientDriverId: "claude",
      aiClientInstanceId: "claude.default",
      projectId: "test-project"
    });

    expect(commands).toEqual([]);
    expect(mockCheckClaude).toHaveBeenCalledOnce();
  });

  it("returns empty array when runtime check throws", async () => {
    mockCheckClaude.mockRejectedValue(new Error("claude not found"));
    const adapter = createClaudeCommandDiscoveryAdapter();
    const commands = await adapter.discoverCommands({
      aiClientDriverId: "claude",
      aiClientInstanceId: "claude.default",
      projectId: "test-project"
    });

    expect(commands).toEqual([]);
    expect(mockCheckClaude).toHaveBeenCalledOnce();
  });
});
