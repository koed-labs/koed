import { Buffer } from "node:buffer";
import process from "node:process";

const modes = new Set(["supervised", "auto_edit", "auto", "full_access"]);
const reads = new Set(["read", "grep", "find", "ls"]);
const edits = new Set(["write", "edit"]);
const catchUpTools = new Set([
  "memory_answer",
  "memory_answer_result",
  "memory_answer_cancel",
  "work_items_from_doc"
]);

// Loaded explicitly by the managed runner, not by normal Pi discovery.
export default function managedPermissions(pi, environment = process.env) {
  const mode = environment.KOED_MANAGED_PERMISSION_MODE;
  if (!modes.has(mode)) throw new Error("Invalid managed Pi permission mode.");
  const catchUpReadOnly = environment.KOED_MANAGED_CATCH_UP_READ_ONLY === "1";
  const sessionGrants = new Set();
  pi.on("session_start", () => {
    sessionGrants.clear();
    if (catchUpReadOnly) pi.setActiveTools([...catchUpTools]);
  });
  pi.on("session_shutdown", () => sessionGrants.clear());
  pi.on("tool_call", async (event, context) => {
    if (catchUpReadOnly) {
      if (
        !catchUpTools.has(event.toolName) ||
        (event.toolName === "work_items_from_doc" &&
          !["list", "read", "preview"].includes(event.input?.mode))
      )
        return {
          block: true,
          reason: "Koed catch-up allows only recall and document preview."
        };
      return;
    }
    if (mode === "full_access") return;
    if (context.signal?.aborted)
      return { block: true, reason: "Request canceled." };
    if (reads.has(event.toolName) || sessionGrants.has(event.toolName)) return;
    if (mode === "auto_edit" && edits.has(event.toolName)) return;
    // Pi has no native automatic reviewer. Auto falls back to asking.
    if (!context.hasUI)
      return { block: true, reason: "Tool approval requires the Koed UI." };
    const request = JSON.stringify({
      kind: "koed_tool_approval",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input
    });
    if (Buffer.byteLength(request, "utf8") > 256 * 1024) {
      return {
        block: true,
        reason: "Tool approval request exceeds the supported size."
      };
    }
    const decision = await context.ui.select(
      request,
      ["Approve", "Always allow this session", "Decline", "Cancel"],
      { signal: context.signal }
    );
    if (context.signal?.aborted)
      return { block: true, reason: "Request canceled." };
    if (decision === "Always allow this session") {
      sessionGrants.add(event.toolName);
      return;
    }
    if (decision === "Approve") return;
    return { block: true, reason: "User declined tool execution." };
  });
}
