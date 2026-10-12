import { describe, expect, it } from "vitest";
import { verifyCodexTranscriptRewrite } from "../src/codex-transcript-rewrite.js";

type Row = {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  ordinal?: number;
};
const timestamp = "2026-10-07T00:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000001";
const otherThreadId = "00000000-0000-4000-8000-000000000002";
const event = (payload: Record<string, unknown>): Row => ({
  timestamp,
  type: "event_msg",
  payload
});
const header: Row = {
  timestamp,
  type: "session_meta",
  payload: { id: threadId }
};
const paginatedHeader: Row = {
  ...header,
  payload: { id: threadId, history_mode: "paginated" }
};
const start = (turnId: string) =>
  event({ type: "task_started", turn_id: turnId });
const finish = (turnId: string) =>
  event({ type: "task_complete", turn_id: turnId });
const completed = (item: Record<string, unknown>, turnId = "turn-1") =>
  event({
    type: "item_completed",
    thread_id: threadId,
    turn_id: turnId,
    item,
    completed_at_ms: Date.parse(timestamp)
  });
const bytes = (records: Row[]) =>
  Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
const ordinal = (records: Row[]) =>
  records.map((record, index) => ({ ...record, ordinal: index }));
const verify = (previous: Row[], rewritten: Row[]) =>
  verifyCodexTranscriptRewrite({
    previousBytes: bytes(previous),
    rewrittenBytes: bytes(ordinal(rewritten)),
    externalSessionId: threadId
  });
const user = (message: string) =>
  event({ type: "user_message", message, text_elements: [] });
const userItem = (text: string, id: string, turnId: string) =>
  completed(
    {
      type: "UserMessage",
      id,
      content: [{ type: "text", text, text_elements: [] }]
    },
    turnId
  );
const agent = (message: string) => event({ type: "agent_message", message });
const agentItem = (text: string, id: string, turnId: string) =>
  completed(
    { type: "AgentMessage", id, content: [{ type: "Text", text }] },
    turnId
  );

describe("frozen native legacy migration parity", () => {
  it.each([
    {
      cwd: "/fixture/a dir/#file%",
      expected: "file:///fixture/a%20dir/%23file%25"
    },
    { cwd: "/fixture/./nested/../", expected: "file:///fixture/" },
    { cwd: "c:\\fixture\\a dir", expected: "file:///C:/fixture/a%20dir" },
    { cwd: "file:///c:/fixture", expected: "file:///C:/fixture" }
  ])(
    "normalizes legacy command cwd $cwd without depending on the host",
    ({ cwd, expected }) => {
      const source = {
        type: "exec_command_end",
        call_id: "command-1",
        turn_id: "turn-1",
        command: ["printf", "fixture"],
        cwd,
        parsed_cmd: [],
        source: "agent",
        status: "completed",
        exit_code: 0,
        duration: { secs: 0, nanos: 0 },
        aggregated_output: ""
      };
      const native = {
        type: "CommandExecution",
        id: "command-1",
        command: source.command,
        cwd: expected,
        parsed_cmd: [],
        source: "agent",
        status: "completed",
        exit_code: 0,
        duration: source.duration
      };
      expect(
        verify(
          [header, start("turn-1"), event(source), finish("turn-1")],
          [
            paginatedHeader,
            start("turn-1"),
            completed(native),
            finish("turn-1")
          ]
        ).liveStartLine
      ).toBe(4);
    }
  );

  it.each([
    "relative/path",
    "\\\\server\\share",
    "\\\\?\\C:\\fixture",
    "/C:/ambiguous",
    "/fixture\u0000path"
  ])(
    "blocks command cwd requiring unimplemented native interpretation: %s",
    (cwd) => {
      expect(() =>
        verify(
          [header, event({ type: "exec_command_end", cwd })],
          [paginatedHeader]
        )
      ).toThrow("codex_rollout_rewrite_path_normalization_unsupported");
    }
  );

  it("normalizes legacy collaboration settings, sandbox modes, and nullable turn context", () => {
    const source: Row = {
      timestamp,
      type: "turn_context",
      payload: {
        cwd: "/fixture",
        approval_policy: "never",
        model: "fixture-model",
        personality: null,
        effort: null,
        summary: "auto",
        sandbox_policy: { mode: "workspace-write" },
        collaboration_mode: {
          mode: "plan",
          model: "fixture-model",
          reasoning_effort: null,
          developer_instructions: null
        }
      }
    };
    const native: Row = {
      ...source,
      payload: {
        cwd: "/fixture",
        approval_policy: "never",
        model: "fixture-model",
        summary: "auto",
        sandbox_policy: {
          type: "workspace-write",
          network_access: false,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false
        },
        collaboration_mode: {
          mode: "plan",
          settings: {
            model: "fixture-model",
            reasoning_effort: null,
            developer_instructions: null
          }
        }
      }
    };
    expect(
      verify([header, source], [paginatedHeader, native]).liveStartLine
    ).toBe(2);
    const changed = structuredClone(native);
    (
      changed.payload.collaboration_mode as { settings: { model: string } }
    ).settings.model = "another-model";
    expect(() => verify([header, source], [paginatedHeader, changed])).toThrow(
      "codex_rollout_rewrite_unproven"
    );
  });

  it("normalizes legacy rate-limit resets with offset and fractional seconds", () => {
    const reset = "2026-10-07T07:00:00.123456+07:00";
    const source = event({
      type: "token_count",
      info: null,
      rate_limits: {
        primary: { used_percent: 2, window_minutes: 300, resets_at: reset }
      }
    });
    const native = event({
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: null,
        limit_name: null,
        primary: {
          used_percent: 2,
          window_minutes: 300,
          resets_at: Math.floor(Date.parse(reset) / 1000)
        },
        secondary: null,
        credits: null,
        individual_limit: null,
        spend_control_reached: null,
        plan_type: null,
        rate_limit_reached_type: null
      }
    });
    expect(
      verify([header, source], [paginatedHeader, native]).liveStartLine
    ).toBe(2);
  });

  it("retains native non-null personality and context extensions as exact passthrough evidence", () => {
    const context: Row = {
      timestamp,
      type: "turn_context",
      payload: {
        cwd: "/fixture",
        workspace_roots: ["/fixture"],
        current_date: "2026-10-07",
        timezone: "Asia/Bangkok",
        approval_policy: "never",
        sandbox_policy: { type: "read-only" },
        model: "fixture-model",
        personality: "none",
        collaboration_mode: {
          mode: "default",
          settings: {
            model: "fixture-model",
            reasoning_effort: null,
            developer_instructions: null
          }
        },
        summary: "auto"
      }
    };
    expect(
      verify([header, context], [paginatedHeader, context]).liveStartLine
    ).toBe(2);
  });

  it.each(["not-a-timestamp", "2026-02-30T00:00:00Z", "2026-10-07T24:00:00Z"])(
    "blocks invalid legacy reset timestamp %s",
    (resets_at) => {
      expect(() =>
        verify(
          [
            header,
            event({
              type: "token_count",
              rate_limits: { primary: { used_percent: 2, resets_at } }
            })
          ],
          [paginatedHeader]
        )
      ).toThrow("codex_rollout_rewrite_rate_limit_normalization_unsupported");
    }
  );

  it("normalizes a legacy review prompt into an exact custom review target", () => {
    const previous = [
      header,
      start("turn-1"),
      event({ type: "entered_review_mode", prompt: "Fixture review" }),
      finish("turn-1")
    ];
    const rewritten = [
      paginatedHeader,
      start("turn-1"),
      completed({
        type: "EnteredReviewMode",
        id: "item-1",
        target: { type: "custom", instructions: "Fixture review" },
        user_facing_hint: "Review requested."
      }),
      finish("turn-1")
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(4);
  });

  it("skips known retired records before counting native implicit-turn source indices", () => {
    const previous = [
      header,
      event({ type: "guardian_assessment" }),
      event({ type: "thread_name_updated" }),
      event({ type: "undo_completed" }),
      { timestamp, type: "response_item", payload: { type: "ghost_snapshot" } },
      user("Fixture prompt")
    ];
    const rewritten = [
      paginatedHeader,
      event({
        type: "task_started",
        turn_id: "rollout-1",
        started_at: Date.parse(timestamp) / 1000,
        model_context_window: null,
        collaboration_mode_kind: "default"
      }),
      userItem("Fixture prompt", "item-1", "rollout-1"),
      event({
        type: "task_complete",
        turn_id: "rollout-1",
        last_agent_message: null,
        completed_at: Date.parse(timestamp) / 1000
      })
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(4);
  });

  it("omits transient normalized command-begin records without skipping their native source index", () => {
    const previous = [
      header,
      event({ type: "exec_command_begin", cwd: "/fixture" }),
      user("Fixture prompt")
    ];
    const rewritten = [
      paginatedHeader,
      event({
        type: "task_started",
        turn_id: "rollout-2",
        started_at: Date.parse(timestamp) / 1000,
        model_context_window: null,
        collaboration_mode_kind: "default"
      }),
      userItem("Fixture prompt", "item-1", "rollout-2"),
      event({
        type: "task_complete",
        turn_id: "rollout-2",
        last_agent_message: null,
        completed_at: Date.parse(timestamp) / 1000
      })
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(4);
  });
  it.each([
    {
      options: {},
      expected: {
        revisedPrompt: null,
        transparentBackground: null,
        failure: null
      }
    },
    {
      options: {
        revised_prompt: "Fixture revision",
        transparent_background: true,
        saved_path: "/fixture/image.png",
        failure: {
          type: "usageLimitExceeded",
          limitId: "fixture",
          resetsAt: null
        }
      },
      expected: {
        revisedPrompt: "Fixture revision",
        transparentBackground: true,
        savedPath: "/fixture/image.png",
        failure: {
          type: "usageLimitExceeded",
          limitId: "fixture",
          resetsAt: null
        }
      }
    }
  ])(
    "verifies extension-owned image completion including every optional field",
    ({ options, expected }) => {
      const previous = [
        header,
        start("turn-1"),
        event({
          type: "image_generation_end",
          call_id: "image-1",
          status: "completed",
          result: "fixture-image",
          ...options
        }),
        finish("turn-1")
      ];
      const rewritten = [
        paginatedHeader,
        start("turn-1"),
        completed({
          type: "Extension",
          kind: "image_gen.generation",
          id: "image-1",
          status: "completed",
          result: "fixture-image",
          ...expected
        }),
        finish("turn-1")
      ];
      expect(verify(previous, rewritten).liveStartLine).toBe(4);
      const altered = structuredClone(rewritten);
      (altered[2]!.payload.item as Record<string, unknown>).result =
        "Changed image";
      expect(() => verify(previous, altered)).toThrow(
        "codex_rollout_rewrite_unproven"
      );
    }
  );

  it("omits empty agent events under native paginated persistence without allocating an item ID", () => {
    const previous = [
      header,
      start("turn-1"),
      agent(""),
      agent("Fixture answer"),
      finish("turn-1")
    ];
    const rewritten = [
      paginatedHeader,
      start("turn-1"),
      agentItem("Fixture answer", "item-1", "turn-1"),
      finish("turn-1")
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(4);
  });

  it.each([
    { type: "Plan", id: "plan-1", text: "Fixture plan" },
    {
      type: "FunctionCallOutput",
      id: "output-1",
      name: "fixture",
      namespace: null,
      output: "Fixture output"
    },
    { type: "Extension", kind: "clock.sleep", id: "sleep-1", durationMs: 1000 },
    {
      type: "SubAgentActivity",
      id: "activity-1",
      kind: "completed",
      agent_thread_id: otherThreadId,
      agent_path: "1"
    }
  ])(
    "normalizes preserved legacy $type identity and default completion timing",
    (item) => {
      const previous = [
        header,
        event({
          type: "item_completed",
          thread_id: otherThreadId,
          turn_id: "retained-turn",
          item,
          started_at_ms: null
        })
      ];
      const normalized = { ...item } as Record<string, unknown>;
      if (normalized.type === "FunctionCallOutput") delete normalized.namespace;
      if (normalized.type === "SubAgentActivity") {
        normalized.model = null;
        normalized.reasoning_effort = null;
      }
      const rewritten = [
        paginatedHeader,
        event({
          type: "item_completed",
          thread_id: threadId,
          turn_id: "retained-turn",
          item: normalized,
          completed_at_ms: 0
        })
      ];
      expect(verify(previous, rewritten).liveStartLine).toBe(2);
      const changed = structuredClone(rewritten);
      (changed[1]!.payload.item as Record<string, unknown>).id = "changed-item";
      expect(() => verify(previous, changed)).toThrow(
        "codex_rollout_rewrite_unproven"
      );
    }
  );

  const hook = (
    id: string | undefined,
    text = "Retry with care &amp; joy."
  ): Row => ({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      ...(id ? { id } : {}),
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<hook_prompt hook_run_id="hook-1">${text}</hook_prompt>`
        }
      ]
    }
  });
  const hookItem = (id = "msg_fixture") => ({
    type: "HookPrompt",
    id,
    fragments: [{ text: "Retry with care & joy.", hookRunId: "hook-1" }]
  });

  it("verifies a preserved hook response followed by its deterministic completed item", () => {
    const previous = [
      header,
      start("turn-1"),
      hook("msg_fixture"),
      finish("turn-1")
    ];
    const rewritten = [
      paginatedHeader,
      start("turn-1"),
      hook("msg_fixture"),
      completed(hookItem()),
      finish("turn-1")
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(5);
    const changed = structuredClone(rewritten);
    (
      changed[3]!.payload.item as { fragments: Array<{ text: string }> }
    ).fragments[0]!.text = "Changed text";
    expect(() => verify(previous, changed)).toThrow(
      "codex_rollout_rewrite_hook_unproven"
    );
  });

  it("verifies an implicit native hook turn without consuming a generated item index", () => {
    const previous = [header, hook("msg_fixture")];
    const rewritten = [
      paginatedHeader,
      hook("msg_fixture"),
      event({
        type: "task_started",
        turn_id: "rollout-1",
        started_at: Date.parse(timestamp) / 1000,
        model_context_window: null,
        collaboration_mode_kind: "default"
      }),
      completed(hookItem(), "rollout-1"),
      event({
        type: "task_complete",
        turn_id: "rollout-1",
        last_agent_message: null,
        completed_at: Date.parse(timestamp) / 1000
      })
    ];
    expect(verify(previous, rewritten).liveStartLine).toBe(5);
  });

  it("blocks UUID-only hook identity that cannot be proved from retained source", () => {
    const previous = [
      header,
      start("turn-1"),
      hook(undefined),
      finish("turn-1")
    ];
    const rewritten = [
      paginatedHeader,
      start("turn-1"),
      hook(undefined),
      completed(hookItem(otherThreadId)),
      finish("turn-1")
    ];
    expect(() => verify(previous, rewritten)).toThrow(
      "codex_rollout_rewrite_hook_unproven"
    );
  });

  it("checks exact native synthesized item numbering for a complete admitted source", () => {
    expect(() =>
      verify(
        [header, start("turn-1"), user("Fixture"), finish("turn-1")],
        [
          paginatedHeader,
          start("turn-1"),
          userItem("Fixture", "item-9", "turn-1"),
          finish("turn-1")
        ]
      )
    ).toThrow("codex_rollout_rewrite_unproven");
  });

  it("verifies event-only rollback ownership, late surviving completions, and subsequent turns", () => {
    const command = {
      type: "exec_command_end",
      call_id: "command-1",
      turn_id: "turn-1",
      command: ["printf", "fixture"],
      cwd: "file:///fixture",
      parsed_cmd: [],
      source: "agent",
      status: "completed",
      exit_code: 0,
      duration: { secs: 0, nanos: 0 },
      aggregated_output: "Fixture output"
    };
    const nativeCommand = {
      type: "CommandExecution",
      id: "command-1",
      command: command.command,
      cwd: command.cwd,
      parsed_cmd: [],
      source: "agent",
      status: "completed",
      exit_code: 0,
      duration: command.duration,
      aggregated_output: command.aggregated_output
    };
    const previous = [
      header,
      start("turn-1"),
      user("Kept prompt"),
      agent("Kept answer"),
      finish("turn-1"),
      start("turn-2"),
      user("Removed prompt"),
      event(command),
      agent("Removed answer"),
      finish("turn-2"),
      event({ type: "thread_rolled_back", num_turns: 1 }),
      start("turn-3"),
      user("New prompt"),
      agent("New answer"),
      finish("turn-3")
    ];
    const rewritten = [
      paginatedHeader,
      start("turn-1"),
      userItem("Kept prompt", "item-1", "turn-1"),
      agentItem("Kept answer", "item-2", "turn-1"),
      finish("turn-1"),
      completed(nativeCommand),
      start("turn-3"),
      userItem("New prompt", "item-3", "turn-3"),
      agentItem("New answer", "item-4", "turn-3"),
      finish("turn-3")
    ];
    const prefix = ordinal(rewritten);
    expect(verify(previous, [...rewritten, start("live-turn")])).toMatchObject({
      liveStartLine: rewritten.length,
      liveStartOffset: bytes(prefix).length
    });
    const altered = structuredClone(rewritten);
    (altered[5]!.payload.item as Record<string, unknown>).aggregated_output =
      "Changed output";
    expect(() => verify(previous, altered)).toThrow(
      "codex_rollout_rewrite_unproven"
    );
  });

  it.each([1, 0xffff_ffff])(
    "saturates rollback count %s at the known instruction boundary depth",
    (num_turns) => {
      expect(
        verify(
          [
            header,
            start("turn-1"),
            user("Removed"),
            finish("turn-1"),
            event({ type: "thread_rolled_back", num_turns })
          ],
          [paginatedHeader]
        ).liveStartLine
      ).toBe(1);
    }
  );

  it("removes zero-count rollback markers while preserving admitted activity", () => {
    expect(
      verify(
        [
          header,
          start("turn-1"),
          user("Kept"),
          finish("turn-1"),
          event({ type: "thread_rolled_back", num_turns: 0 })
        ],
        [
          paginatedHeader,
          start("turn-1"),
          userItem("Kept", "item-1", "turn-1"),
          finish("turn-1")
        ]
      ).liveStartLine
    ).toBe(4);
  });

  it.each([
    "response_item",
    "compacted",
    "retained_context",
    "inter_agent_communication"
  ])("keeps unsupported rollback ownership shape %s blocked", (type) => {
    expect(() =>
      verify(
        [
          header,
          start("turn-1"),
          user("Fixture"),
          { timestamp, type, payload: {} },
          finish("turn-1"),
          event({ type: "thread_rolled_back", num_turns: 1 })
        ],
        [paginatedHeader]
      )
    ).toThrow("codex_rollout_rewrite_rollback_plan_unsupported");
  });

  it("cannot use rollback to cross a headerless admitted capture frontier", () => {
    expect(() =>
      verify(
        [
          start("turn-1"),
          user("Removed"),
          finish("turn-1"),
          event({ type: "thread_rolled_back", num_turns: 1 })
        ],
        [paginatedHeader]
      )
    ).toThrow("codex_rollout_rewrite_rollback_frontier_unproven");
  });
});
