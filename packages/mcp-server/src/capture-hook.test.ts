import { describe, expect, it } from "vitest";
import {
  extractTranscriptSessionMetadata,
  parseTranscriptText,
  selectCaptureItems
} from "./capture-hook.js";

describe("Codex capture hook transcript parsing", () => {
  it("labels main Codex agent messages as agent", () => {
    const items = parseTranscriptText(
      JSON.stringify([
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Fix the backend capture path"
          }
        },
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "I will inspect the graph API."
          }
        }
      ])
    );

    expect(items).toMatchObject([
      { actor: "user", eventType: "codex_transcript_user" },
      { actor: "agent", eventType: "codex_transcript_agent" }
    ]);
  });

  it("uses child session metadata to label subagent conversation actors", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          type: "session_meta",
          id: "child-session",
          parentSessionId: "parent-session",
          parentThreadId: "parent-thread"
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the capture hook for tool calls."
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The hook drops response_item function calls."
        }
      }
    ];

    const context = extractTranscriptSessionMetadata(records);
    const items = parseTranscriptText(JSON.stringify(records));

    expect(context).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session"
    });
    expect(items).toMatchObject([
      {
        actor: "agent",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread"
        }
      },
      {
        actor: "subagent",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread"
        }
      }
    ]);
  });

  it("uses Codex subagent session metadata to link child threads", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          type: "session_meta",
          id: "child-session",
          thread_source: "subagent",
          agent_nickname: "Reviewer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_role: "worker_gpt55_high"
              }
            }
          }
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the backend branch."
        }
      }
    ];

    const context = extractTranscriptSessionMetadata(records);
    const items = parseTranscriptText(JSON.stringify(records));

    expect(context).toMatchObject({
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      transcriptSessionId: "child-session",
      transcriptMetadata: {
        thread_source: "subagent",
        agent_nickname: "Reviewer"
      }
    });
    expect(items[0]).toMatchObject({
      actor: "agent",
      metadata: {
        threadKind: "subagent",
        parentThreadId: "parent-thread"
      }
    });
  });

  it("captures response_item function calls and outputs as tool events", () => {
    const items = parseTranscriptText(
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed"
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "fco_1",
            call_id: "call_1",
            output: "Tests passed"
          }
        })
      ].join("\n")
    );

    expect(items).toMatchObject([
      {
        actor: "tool",
        eventType: "codex_transcript_tool_call",
        metadata: {
          transcriptType: "function_call",
          callId: "call_1",
          toolName: "exec_command",
          toolEventKind: "function_call",
          status: "completed",
          toolCall: {
            kind: "call",
            id: "call_1",
            name: "exec_command",
            input: { cmd: "pnpm test" },
            status: "completed"
          }
        }
      },
      {
        actor: "tool",
        eventType: "codex_transcript_tool_output",
        metadata: {
          transcriptType: "function_call_output",
          callId: "call_1",
          toolEventKind: "function_call_output",
          toolCall: {
            kind: "output",
            id: "call_1",
            output: "Tests passed"
          }
        }
      }
    ]);
    expect(items[0]?.content).toContain("Tool call: exec_command");
    expect(items[1]?.content).toContain("Tests passed");
  });

  it("captures custom tool calls and outputs as structured tool events", () => {
    const items = parseTranscriptText(
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            id: "ctc_1",
            call_id: "call_patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
            status: "completed"
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            id: "ctco_1",
            call_id: "call_patch",
            output: '{"output":"Success. Updated files"}'
          }
        })
      ].join("\n")
    );

    expect(items).toMatchObject([
      {
        actor: "tool",
        eventType: "codex_transcript_tool_call",
        metadata: {
          transcriptType: "custom_tool_call",
          toolName: "apply_patch",
          toolCallId: "call_patch",
          toolCall: {
            kind: "call",
            id: "call_patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch"
          }
        }
      },
      {
        actor: "tool",
        eventType: "codex_transcript_tool_output",
        metadata: {
          transcriptType: "custom_tool_call_output",
          toolCallId: "call_patch",
          toolCall: {
            kind: "output",
            id: "call_patch",
            output: '{"output":"Success. Updated files"}'
          }
        }
      }
    ]);
    expect(items[0]?.content).toContain("Tool call: apply_patch");
    expect(items[1]?.content).toContain("Success. Updated files");
  });

  it("keeps fallback tool events when transcript messages were found", () => {
    const transcriptItems = parseTranscriptText(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Done" }
      })
    );

    const items = selectCaptureItems(transcriptItems, {
      session_id: "session-a",
      hook_event_name: "PostToolUse",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
      tool_response: "clean"
    });

    expect(items.map((item) => item.actor)).toEqual(["agent", "tool"]);
    expect(items[1]).toMatchObject({
      eventType: "codex_tool_result",
      metadata: {
        toolName: "exec_command",
        toolCall: {
          kind: "hook",
          name: "exec_command",
          input: { cmd: "git status" },
          output: "clean"
        }
      }
    });
    expect(items[1]?.content).toContain("Tool result: exec_command");
  });

  it("uses fallback hook payloads when no transcript messages are available", () => {
    const items = selectCaptureItems([], {
      session_id: "session-b",
      hook_event_name: "UserPromptSubmit",
      prompt: "Capture this prompt"
    });

    expect(items).toMatchObject([
      {
        actor: "user",
        eventType: "codex_user_prompt",
        content: "Capture this prompt",
        metadata: { externalSessionId: "session-b" }
      }
    ]);
  });
});
