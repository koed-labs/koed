/* global fetch */
import process from "node:process";
import { Buffer } from "node:buffer";
import { runCodexMemoryHook } from "@koed/mcp-server/codex-memory-hook";
import { readFixture, recordEvent } from "./fixture-data.mjs";

const fixture = readFixture();
let text = "";
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 256_000)
    throw new Error("Fixture hook input is too large");
}
const input = JSON.parse(text);
if (
  input.hook_event_name === "PreToolUse" &&
  input.tool_name === "mcp__koed_delivery_eval__memory_answer"
)
  recordEvent(fixture, "recall_requested", {
    mode: input.tool_input?.delivery_mode ?? "auto"
  });
if (input.hook_event_name === "PostToolUse") {
  const response =
    input.tool_response?.structuredContent ?? input.tool_response;
  if (
    response?.status === "pending" &&
    response.koedPendingMemoryAnswer?.version === 1
  )
    recordEvent(fixture, "receipt");
}
if (
  input.hook_event_name === "PreToolUse" &&
  (input.tool_name === "sleep" ||
    input.tool_name === "clock.sleep" ||
    (/exec_command$/.test(input.tool_name ?? "") &&
      /\bsleep\b/.test(input.tool_input?.cmd ?? "")))
)
  recordEvent(fixture, "model_poll");
if (fixture.scenario === "fallback") {
  // Instrument the native call, but deliberately omit Koed's preparation.
  // This establishes missing readiness without changing the request.
  process.stdout.write("{}");
} else {
  const stopping =
    input.hook_event_name === "Stop" && input.stop_hook_active === false;
  if (stopping) {
    recordEvent(fixture, "yield");
    await fetch(`${fixture.runtimeUrl}/fixture/yield`, {
      method: "POST",
      headers: { authorization: fixture.authorization },
      redirect: "error"
    });
  }
  const result = await runCodexMemoryHook(input, {
    home: fixture.koedHome,
    memoryTool: "mcp__koed_delivery_eval__memory_answer",
    waitMs: 5000
  });
  if (
    input.hook_event_name === "PreToolUse" &&
    input.tool_name === "mcp__koed_delivery_eval__memory_answer"
  )
    recordEvent(fixture, "hook_preparation", {
      sessionPresent: Boolean(input.session_id),
      callPresent: Boolean(input.tool_use_id),
      turnPresent: Boolean(input.turn_id),
      prepared: Boolean(result.hookSpecificOutput?.updatedInput)
    });
  if (result.decision === "block")
    recordEvent(fixture, "completion", {
      outcome: result.reason?.includes(fixture.memoryMarkdown)
        ? fixture.scenario === "not_found"
          ? "not_found"
          : "found"
        : "failed",
      route: "codex_stop"
    });
  process.stdout.write(JSON.stringify(result));
}
