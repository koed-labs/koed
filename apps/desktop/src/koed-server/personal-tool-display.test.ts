import { describe, expect, it } from "vitest";

import { buildPersonalToolDisplay } from "./personal-tool-display.js";

describe("Personal Memory tool display projection", () => {
  it.each([
    ["exec_command", { input: { cmd: "pnpm test" } }, "command", "Ran command"],
    ["write_stdin", {}, "command", "Ran command"],
    ["read_file", { input: { path: "src/app.ts" } }, "file_read", "Read file"],
    ["rg", { input: { query: "SecureMarkdown" } }, "search", "Searched files"],
    [
      "custom_tool",
      { output: { summary: "Finished safely" } },
      "tool",
      "Custom tool"
    ]
  ])(
    "projects %s into a display-safe summary",
    (name, metadata, kind, label) => {
      expect(
        buildPersonalToolDisplay({
          actor: "tool",
          content: "Raw tool content",
          contentPreview: "Raw preview",
          metadata: {
            toolCall: { name, id: "call-1", status: "completed", ...metadata }
          }
        })
      ).toMatchObject({ kind, label, toolName: name, callId: "call-1" });
    }
  );

  it("projects a nested Codex patch without forwarding its arbitrary metadata", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch";
    const display = buildPersonalToolDisplay({
      actor: "tool",
      content: "Tool call: apply_patch",
      metadata: {
        apiToken: "must-not-cross",
        remoteAuthority: "remote.example",
        toolCall: {
          id: "call-patch",
          input: patch,
          name: "apply_patch",
          status: "completed"
        }
      }
    });

    expect(display).toMatchObject({
      kind: "file_change",
      label: "Changed files",
      patchSource: patch,
      toolName: "apply_patch"
    });
    expect(JSON.stringify(display)).not.toMatch(
      /apiToken|remoteAuthority|remote\.example/u
    );
  });

  it("returns no tool projection for non-tool Memory Events", () => {
    expect(
      buildPersonalToolDisplay({
        actor: "assistant",
        metadata: { toolName: "exec" }
      })
    ).toBeUndefined();
  });

  it("handles malformed metadata and bounds the preview", () => {
    expect(
      buildPersonalToolDisplay({
        actor: "tool",
        content: "x".repeat(4_096),
        metadata: ["not", "an", "object"]
      })
    ).toMatchObject({
      kind: "tool",
      label: "Tool call",
      preview: expect.stringMatching(/^x{2047}…$/u)
    });
  });
});
