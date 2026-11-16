import {
  controlRequestSchema,
  type ControlReply
} from "@koed-labs/shared/local-control-protocol";
import type { HostCore } from "./host-core.js";

/** Call only after native authentication and the connection hello have succeeded. */
export function dispatchControlRequest(
  core: HostCore,
  value: unknown,
  desktop?: { attach(): void; detach(intentional: boolean): void }
): ControlReply {
  const request = controlRequestSchema.parse(value);
  const current = core.status();
  const fail = (
    code:
      | "incompatible"
      | "stale_revision"
      | "blocked"
      | "unsupported_operation"
  ): ControlReply => ({
    requestId: request.requestId,
    ok: false,
    code,
    snapshot: core.status()
  });
  if (request.instanceId !== current.instanceId) return fail("incompatible");
  if (request.command.action === "status")
    return { requestId: request.requestId, ok: true, snapshot: current };
  if (request.expectedRevision !== current.revision)
    return fail("stale_revision");
  try {
    switch (request.command.action) {
      case "start":
        return {
          requestId: request.requestId,
          ok: true,
          snapshot: core.start(request.command.explicit)
        };
      case "stop":
        return {
          requestId: request.requestId,
          ok: true,
          snapshot: core.stop(request.command.explicit)
        };
      case "attach":
        if (request.command.reason === "desktop-session") {
          if (!desktop) return fail("unsupported_operation");
          desktop.attach();
          return {
            requestId: request.requestId,
            ok: true,
            snapshot: core.status()
          };
        }
        return {
          requestId: request.requestId,
          ok: true,
          snapshot: core.attach(request.command.reason)
        };
      case "detach":
        if (request.command.reason === "desktop-session") {
          if (!desktop) return fail("unsupported_operation");
          desktop.detach(request.command.intentional);
          return {
            requestId: request.requestId,
            ok: true,
            snapshot: core.status()
          };
        }
        return {
          requestId: request.requestId,
          ok: true,
          snapshot: core.detach(request.command.reason)
        };
      default:
        return fail("unsupported_operation");
    }
  } catch {
    return fail("blocked");
  }
}
