import { describe, expect, it } from "vitest";
import { buildConversationToolDisplay } from "./conversation-display.js";

describe("conversation command display", () => {
  it("renders native argv with explicit argument boundaries without changing evidence", () => {
    const argv = [
      "printf",
      "two words",
      "$(fixture)",
      "quote'\"",
      "line\nbreak",
      ""
    ];
    const input = { cmd: argv };
    const display = buildConversationToolDisplay({
      actor: "tool",
      content: "Tool call: exec_command",
      metadata: { toolCall: { name: "exec_command", input } }
    });
    expect(display).toMatchObject({
      toolName: "exec_command",
      preview: JSON.stringify(argv)
    });
    expect(input.cmd).toEqual(argv);
  });

  it("preserves existing string command presentation", () => {
    expect(
      buildConversationToolDisplay({
        actor: "tool",
        metadata: { toolName: "exec_command", input: { cmd: "pnpm test" } }
      })
    ).toMatchObject({ preview: "pnpm test" });
  });

  it("does not treat malformed argv as a valid command", () => {
    expect(
      buildConversationToolDisplay({
        actor: "tool",
        content: "Fixture fallback",
        metadata: {
          toolName: "exec_command",
          input: { cmd: ["printf", { unsupported: true }] }
        }
      })
    ).toMatchObject({ preview: "Fixture fallback" });
  });
});
