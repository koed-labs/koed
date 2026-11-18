import { describe, expect, it, vi } from "vitest";
import { dispatchControlRequest } from "./dispatch.js";
import type { HostCore, HostSnapshot } from "./host-core.js";

const snapshot: HostSnapshot = {
  instanceId: "current",
  revision: 4,
  state: "stopped",
  stopIntent: false,
  backgroundEnabled: false
};
function fixture() {
  const core: HostCore = {
    status: vi.fn(() => snapshot),
    settled: vi.fn(() => true),
    start: vi.fn(() => snapshot),
    stop: vi.fn(() => snapshot),
    attach: vi.fn(() => snapshot),
    detach: vi.fn(() => snapshot),
    openDesktopSession: vi.fn(() => ({ close: vi.fn() }))
  };
  return core;
}
const request = (command: object, extra = {}) => ({
  requestId: "request",
  instanceId: "current",
  expectedRevision: 4,
  command,
  ...extra
});
describe("control request dispatch", () => {
  it("serves status and dispatches authorized valid commands", () => {
    const core = fixture();
    expect(
      dispatchControlRequest(core, request({ action: "status" }))
    ).toMatchObject({ ok: true, snapshot });
    expect(
      dispatchControlRequest(core, request({ action: "start", explicit: true }))
    ).toMatchObject({ ok: true });
    expect(core.start).toHaveBeenCalledWith(true);
    expect(
      dispatchControlRequest(core, request({ action: "stop", explicit: true }))
    ).toMatchObject({ ok: true });
    expect(core.stop).toHaveBeenCalledWith(true);
  });
  it("dispatches Agent availability through the control plane", () => {
    const core = fixture();
    expect(
      dispatchControlRequest(
        core,
        request({ action: "attach", reason: "background-agent" })
      )
    ).toMatchObject({ ok: true });
    expect(
      dispatchControlRequest(
        core,
        request({
          action: "detach",
          reason: "background-agent",
          intentional: true
        })
      )
    ).toMatchObject({ ok: true });
    expect(core.attach).toHaveBeenCalledWith("background-agent");
    expect(core.detach).toHaveBeenCalledWith("background-agent");
  });
  it("rejects stale revisions and other control-plane instances without effects", () => {
    const core = fixture();
    expect(
      dispatchControlRequest(
        core,
        request({ action: "start", explicit: true }, { expectedRevision: 3 })
      )
    ).toMatchObject({ ok: false, code: "stale_revision" });
    expect(
      dispatchControlRequest(
        core,
        request({ action: "stop", explicit: true }, { instanceId: "old" })
      )
    ).toMatchObject({ ok: false, code: "incompatible" });
    expect(core.start).not.toHaveBeenCalled();
    expect(core.stop).not.toHaveBeenCalled();
  });
  it("rejects malformed messages and unsupported operations without effects", () => {
    const core = fixture();
    expect(() =>
      dispatchControlRequest(
        core,
        request({ action: "start", explicit: "yes" })
      )
    ).toThrow();
    expect(
      dispatchControlRequest(core, request({ action: "retire" }))
    ).toMatchObject({ ok: false, code: "unsupported_operation" });
    expect(core.start).not.toHaveBeenCalled();
    expect(core.stop).not.toHaveBeenCalled();
  });
  it("dispatches retirement only after instance and revision fences and gates later Starts", () => {
    const core = fixture();
    let retiring = false;
    const retire = vi.fn(() => {
      retiring = true;
      return { ...snapshot, stopIntent: true };
    });
    const lifecycle = { retire, retiring: () => retiring };
    const command = { action: "retire" };
    expect(
      dispatchControlRequest(
        core,
        request(command, { instanceId: "old" }),
        undefined,
        lifecycle
      )
    ).toMatchObject({ ok: false, code: "incompatible" });
    expect(
      dispatchControlRequest(
        core,
        request(command, { expectedRevision: 3 }),
        undefined,
        lifecycle
      )
    ).toMatchObject({ ok: false, code: "stale_revision" });
    expect(retire).not.toHaveBeenCalled();
    expect(
      dispatchControlRequest(core, request(command), undefined, lifecycle)
    ).toMatchObject({ ok: true, snapshot: { stopIntent: true } });
    expect(
      dispatchControlRequest(
        core,
        request({ action: "start", explicit: true }),
        undefined,
        lifecycle
      )
    ).toMatchObject({ ok: false, code: "blocked" });
    expect(core.start).not.toHaveBeenCalled();
  });
  it("reports blocked operations without exposing internal errors", () => {
    const core = fixture();
    vi.mocked(core.start).mockImplementation(() => {
      throw new Error("internal-only detail");
    });
    const reply = dispatchControlRequest(
      core,
      request({ action: "start", explicit: true })
    );
    expect(reply).toMatchObject({ ok: false, code: "blocked" });
    expect(JSON.stringify(reply)).not.toContain("internal-only detail");
  });
});
