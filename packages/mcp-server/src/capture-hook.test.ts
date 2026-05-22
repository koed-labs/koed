import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureTranscriptPathForPayload,
  effectiveCaptureContext,
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
          id: "child-session",
          thread_source: "subagent",
          agent_nickname: "Reviewer",
          agent_role: "code-reviewer",
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
        id: "child-session",
        thread_source: "subagent",
        agent_nickname: "Reviewer",
        agent_role: "code-reviewer"
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

  it("uses the child transcript id as the effective subagent external session", () => {
    const records = [
      {
        type: "session_meta",
        payload: {
          id: "child-thread",
          thread_source: "subagent",
          agent_nickname: "Reviewer",
          agent_role: "code-reviewer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread"
              }
            }
          }
        }
      }
    ];

    const transcriptContext = extractTranscriptSessionMetadata(records);
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "agent-thread-from-hook",
        agent_type: "review",
        hook_event_name: "SubagentStop",
        transcript_path: "/tmp/parent.jsonl",
        agent_transcript_path: "/tmp/child.jsonl"
      },
      transcriptContext
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread",
      transcriptPath: "/tmp/child.jsonl",
      parentTranscriptPath: "/tmp/parent.jsonl",
      agentId: "agent-thread-from-hook",
      agentType: "review",
      isSubagent: true
    });

    expect(
      selectCaptureItems(
        [],
        {
          session_id: "parent-thread",
          agent_id: "agent-thread-from-hook",
          hook_event_name: "UserPromptSubmit",
          prompt: "Review this change"
        },
        effectiveContext
      )
    ).toMatchObject([
      {
        actor: "agent",
        metadata: {
          threadKind: "subagent",
          externalSessionId: "child-thread",
          parentThreadId: "parent-thread"
        }
      }
    ]);
  });

  it("falls back to hook agent_id for subagent capture when metadata has no id", () => {
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "child-thread-from-hook",
        hook_event_name: "SubagentStart"
      },
      {
        threadKind: "subagent",
        parentThreadId: "parent-thread",
        transcriptMetadata: {}
      }
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread-from-hook",
      parentThreadId: "parent-thread",
      isSubagent: true
    });
  });

  it("does not preserve a self-referential parent link", () => {
    const effectiveContext = effectiveCaptureContext(
      {
        session_id: "parent-thread",
        agent_id: "child-thread",
        hook_event_name: "SubagentStop"
      },
      {
        threadKind: "subagent",
        transcriptSessionId: "child-thread",
        parentThreadId: "child-thread",
        transcriptMetadata: {}
      }
    );

    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread"
    });
  });

  it("uses agent_transcript_path for SubagentStop transcript parsing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    const parentTranscriptPath = path.join(dir, "parent.jsonl");
    const agentTranscriptPath = path.join(dir, "child.jsonl");
    fs.writeFileSync(
      parentTranscriptPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Parent answer" }
      })}\n`
    );
    fs.writeFileSync(
      agentTranscriptPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "child-thread",
            thread_source: "subagent",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread"
                }
              }
            }
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Child final answer"
          }
        })
      ].join("\n")
    );

    const payload = {
      session_id: "parent-thread",
      agent_id: "child-thread",
      hook_event_name: "SubagentStop",
      transcript_path: parentTranscriptPath,
      agent_transcript_path: agentTranscriptPath
    };
    const selectedPath = captureTranscriptPathForPayload(payload);
    const items = parseTranscriptText(fs.readFileSync(selectedPath!, "utf8"));
    const transcriptContext = extractTranscriptSessionMetadata([
      {
        type: "session_meta",
        payload: {
          id: "child-thread",
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread"
              }
            }
          }
        }
      }
    ]);
    const effectiveContext = effectiveCaptureContext(
      payload,
      transcriptContext
    );

    expect(selectedPath).toBe(agentTranscriptPath);
    expect(items).toMatchObject([
      {
        actor: "subagent",
        content: "Child final answer",
        metadata: {
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          transcriptSessionId: "child-thread"
        }
      }
    ]);
    expect(effectiveContext).toMatchObject({
      externalSessionId: "child-thread",
      parentThreadId: "parent-thread"
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
