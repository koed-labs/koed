import { describe, expect, it } from "vitest";

import { requireSupportedAiClientPermissionMode } from "../src/ai-client-permission-mode.js";

describe("AI Client permission-mode mappings", () => {
  it.each([
    ["supervised", "untrusted", "read-only", "user"],
    ["auto_edit", "on-request", "workspace-write", "user"],
    ["auto", "on-request", "workspace-write", "auto_review"],
    ["full_access", "never", "danger-full-access", "user"]
  ] as const)(
    "maps Codex %s to native controls",
    (mode, approvalPolicy, sandboxMode, approvalsReviewer) => {
      expect(
        requireSupportedAiClientPermissionMode({ driverId: "codex", mode })
      ).toEqual({
        driverId: "codex",
        approvalPolicy,
        sandboxMode,
        approvalsReviewer
      });
    }
  );

  it.each([
    ["supervised", "default"],
    ["auto_edit", "acceptEdits"],
    ["auto", "auto"],
    ["full_access", "bypassPermissions"]
  ] as const)("maps Claude %s to native controls", (mode, permissionMode) => {
    expect(
      requireSupportedAiClientPermissionMode({ driverId: "claude", mode })
    ).toEqual({
      driverId: "claude",
      permissionMode
    });
  });
});
