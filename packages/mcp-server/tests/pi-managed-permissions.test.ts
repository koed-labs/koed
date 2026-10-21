import { describe, expect, it, vi } from "vitest";
import managedPermissions from "../integrations/pi/managed-permissions.mjs";

type PermissionApi = Parameters<typeof managedPermissions>[0];

function fixture(mode: string, catchUpReadOnly = false) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const setActiveTools = vi.fn();
  const api = {
    on: ((name: string, handler: (...args: never[]) => unknown) => {
      handlers.set(name, handler as (...args: unknown[]) => unknown);
    }) as PermissionApi["on"],
    setActiveTools
  };
  managedPermissions(api, {
    KOED_MANAGED_PERMISSION_MODE: mode,
    ...(catchUpReadOnly ? { KOED_MANAGED_CATCH_UP_READ_ONLY: "1" } : {})
  });
  const select = vi.fn().mockResolvedValue("Decline");
  const controller = new AbortController();
  return {
    handlers,
    select,
    setActiveTools,
    controller,
    call: (
      toolName: string,
      input: Record<string, unknown> = { command: "echo hello" }
    ) =>
      handlers.get("tool_call")!(
        { toolName, toolCallId: "call-1", input },
        { hasUI: true, signal: controller.signal, ui: { select } }
      )
  };
}

describe("managed Pi tool permissions", () => {
  it("runs full access tools without prompting", async () => {
    const f = fixture("full_access");
    expect(await f.call("bash")).toBeUndefined();
    expect(f.select).toHaveBeenCalledTimes(0);
  });
  it.each(["supervised", "auto"])(
    "asks before commands in %s",
    async (mode) => {
      const f = fixture(mode);
      expect(await f.call("bash")).toMatchObject({ block: true });
      expect(f.select).toHaveBeenCalledTimes(1);
      f.select.mockResolvedValue("Approve");
      expect(await f.call("bash")).toBeUndefined();
    }
  );
  it("auto-accepts edits but asks before shell commands", async () => {
    const f = fixture("auto_edit");
    expect(await f.call("edit")).toBeUndefined();
    expect(await f.call("write")).toBeUndefined();
    expect(await f.call("bash")).toMatchObject({ block: true });
    expect(f.select).toHaveBeenCalledTimes(1);
  });
  it("scopes remembered grants to the selected tool and session", async () => {
    const f = fixture("supervised");
    f.select.mockResolvedValueOnce("Always allow this session");
    expect(await f.call("bash")).toBeUndefined();
    expect(await f.call("bash")).toBeUndefined();
    expect(await f.call("edit")).toMatchObject({ block: true });
    f.handlers.get("session_start")!();
    expect(await f.call("bash")).toMatchObject({ block: true });
  });
  it("does not execute a tool after its pending approval is canceled", async () => {
    const f = fixture("supervised");
    f.select.mockImplementation(async () => {
      f.controller.abort();
      return "Approve";
    });
    expect(await f.call("bash")).toMatchObject({ block: true });
  });
  it("uses a strict catch-up tool set even when the User selected full access", async () => {
    const f = fixture("full_access", true);
    f.handlers.get("session_start")!();
    expect(f.setActiveTools).toHaveBeenCalledWith([
      "memory_answer",
      "memory_answer_result",
      "memory_answer_cancel",
      "work_items_from_doc"
    ]);
    for (const name of [
      "bash",
      "read",
      "write",
      "memory_forget",
      "work_item_complete"
    ])
      expect(await f.call(name)).toMatchObject({ block: true });
    for (const mode of ["list", "read", "preview"])
      expect(await f.call("work_items_from_doc", { mode })).toBeUndefined();
    expect(
      await f.call("work_items_from_doc", { mode: "apply" })
    ).toMatchObject({ block: true });
    expect(await f.call("memory_answer")).toBeUndefined();
    expect(f.select).not.toHaveBeenCalled();
  });
});
