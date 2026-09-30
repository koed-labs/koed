import { describe, expect, it, vi } from "vitest";
import managedAgentTools from "../integrations/pi/managed-agent-tools.mjs";

interface RegisteredTool {
  name: string;
  parameters: { additionalProperties: boolean };
  execute(
    id: string,
    input: Record<string, string>,
    signal: AbortSignal,
    update: undefined,
    context: {
      hasUI: boolean;
      ui: {
        input: (
          title: string,
          placeholder: string,
          options: { signal: AbortSignal }
        ) => Promise<string | undefined>;
      };
    }
  ): Promise<{ details: Record<string, unknown> }>;
}

describe("managed Pi native Agent tools", () => {
  it("registers only enabled tools and waits for the managed authority response", async () => {
    const registerTool = vi.fn<(tool: RegisteredTool) => void>();
    managedAgentTools(
      { registerTool },
      { KOED_MANAGED_AGENT_INTENT_TOOL: "1" }
    );
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]![0];
    expect(tool.name).toBe("koed_agent_intent");
    expect(tool.parameters.additionalProperties).toBe(false);
    const input = vi
      .fn<
        (
          title: string,
          placeholder: string,
          options: { signal: AbortSignal }
        ) => Promise<string | undefined>
      >()
      .mockResolvedValue(JSON.stringify({ recorded: true, jobId: "job" }));
    const result = await tool.execute(
      "tool",
      { kind: "assign", goal: "Review" },
      new AbortController().signal,
      undefined,
      { hasUI: true, ui: { input } }
    );
    expect(JSON.parse(input.mock.calls[0]![0])).toEqual({
      kind: "koed_agent_intent",
      signal: { kind: "assign", goal: "Review" }
    });
    expect(result.details).toEqual({ recorded: true, jobId: "job" });
  });
  it("rejects a canceled authority response and never registers outside managed opt-in", async () => {
    const registerTool = vi.fn<(tool: RegisteredTool) => void>();
    managedAgentTools({ registerTool }, {});
    expect(registerTool).not.toHaveBeenCalled();
    managedAgentTools(
      { registerTool },
      { KOED_MANAGED_AGENT_TURN_STATUS_TOOL: "1" }
    );
    const tool = registerTool.mock.calls[0]![0];
    expect(tool.name).toBe("koed_agent_turn_status");
    await expect(
      tool.execute(
        "tool",
        { status: "complete" },
        new AbortController().signal,
        undefined,
        { hasUI: true, ui: { input: vi.fn().mockResolvedValue(undefined) } }
      )
    ).rejects.toThrow("declined");
  });
});
