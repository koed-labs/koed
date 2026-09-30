import { describe, expect, it, vi } from "vitest";
import managedPermissions from "../integrations/pi/managed-permissions.mjs";

type PermissionApi = Parameters<typeof managedPermissions>[0];

function fixture(mode: string, gate = false) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  managedPermissions(
    {
      on: ((name: string, handler: (...args: never[]) => unknown) => {
        handlers.set(name, handler as (...args: unknown[]) => unknown);
      }) as PermissionApi["on"]
    },
    {
      KOED_MANAGED_PERMISSION_MODE: mode,
      ...(gate ? { KOED_MANAGED_AGENT_TOOL_GATE: "1" } : {})
    }
  );
  const select = vi.fn().mockResolvedValue("Decline");
  const controller = new AbortController();
  return {
    handlers,
    select,
    controller,
    call: (toolName: string) =>
      handlers.get("tool_call")!(
        { toolName, toolCallId: "call-1", input: { command: "echo hello" } },
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
  it("lets the current managed Agent command fence work tools even in full access", async () => {
    const f = fixture("full_access", true);
    expect(await f.call("bash")).toMatchObject({ block: true });
    expect(f.select).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"koed_tool_gate"'),
      ["Allow", "Deny", "Use configured permissions"],
      expect.anything()
    );
    f.select.mockResolvedValue("Allow");
    expect(await f.call("edit")).toBeUndefined();
  });
  it("does not ask for user approval for provider-native Agent signals", async () => {
    const f = fixture("supervised", true);
    expect(await f.call("koed_agent_intent")).toBeUndefined();
    expect(await f.call("koed_agent_turn_status")).toBeUndefined();
    expect(f.select).not.toHaveBeenCalled();
    expect(await f.call("bash")).toMatchObject({ block: true });
    expect(f.select).toHaveBeenCalledOnce();
    expect(f.select).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"koed_tool_gate"'),
      ["Allow", "Deny", "Use configured permissions"],
      expect.anything()
    );
  });
});
