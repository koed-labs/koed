import { describe, expect, it, vi } from "vitest";
import {
  createProjectCommands,
  type ProjectCommandsDeps
} from "./project-commands.js";
import {
  createProjectManagementValidationApi,
  validationId
} from "../project-management-validation-api.js";
import { PERSONAL_DESKTOP_CONTRACT_VERSION } from "@koed/shared/personal-desktop";
import { createPersonalMemoryPreloadApi } from "../ipc/personal-memory-preload.js";

describe("atomic organization bridge", () => {
  it("uses the fixed route and binds its response to the reviewed context", async () => {
    const fixture = createProjectManagementValidationApi(),
      sessionId = validationId(100);
    const context = (
      await fixture.api.manageSourceContext!({ action: "get", sessionId })
    ).context;
    const edit = {
      expectedContext: context,
      reviewedProjects: [{ projectId: validationId(1), expectedVersion: 1 }],
      memberships: [
        { projectId: validationId(1), direct: false, excluded: false }
      ],
      corrections: []
    };
    const saved = await fixture.api.manageSourceContext!({
      action: "organize",
      sessionId,
      edit
    });
    const request = vi.fn(
      async () => saved as unknown as Record<string, unknown>
    );
    const commands = createProjectCommands({
      personalRequest: request,
      lookup: {}
    } as unknown as ProjectCommandsDeps);
    await expect(
      commands.manageSourceContext({ action: "organize", sessionId, edit })
    ).resolves.toEqual(saved);
    expect(request).toHaveBeenCalledWith(
      `/v1/personal/sessions/${sessionId}/organization`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit)
      }
    );
    request.mockResolvedValueOnce({ ...saved, organization: undefined });
    await expect(
      commands.manageSourceContext({ action: "organize", sessionId, edit })
    ).rejects.toThrow("another Conversation or review");
    request.mockResolvedValueOnce({
      ...saved,
      context: { ...saved.context, sessionId: validationId(101) }
    });
    await expect(
      commands.manageSourceContext({ action: "organize", sessionId, edit })
    ).rejects.toThrow("another Conversation or review");
  });
  it("validates version-bound edits before IPC and rejects authority or duplicate axes", async () => {
    const fixture = createProjectManagementValidationApi(),
      sessionId = validationId(100);
    const context = (
      await fixture.api.manageSourceContext!({ action: "get", sessionId })
    ).context;
    const edit = {
      expectedContext: context,
      reviewedProjects: [{ projectId: validationId(1), expectedVersion: 1 }],
      memberships: [
        { projectId: validationId(1), direct: false, excluded: false }
      ],
      corrections: []
    };
    const saved = await fixture.api.manageSourceContext!({
      action: "organize",
      sessionId,
      edit
    });
    const invoke = vi.fn(async () => ({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      operation: "personal.sources.manage",
      ok: true,
      data: saved
    }));
    const preload = createPersonalMemoryPreloadApi(invoke, {
      on: vi.fn(),
      removeListener: vi.fn()
    });
    await expect(
      preload.manageSourceContext!({ action: "organize", sessionId, edit })
    ).resolves.toEqual(saved);
    for (const bad of [
      { ...edit, ownerUserId: validationId(999) },
      { ...edit, reviewedProjects: [] },
      {
        ...edit,
        corrections: [{ axis: "git", action: "reset", expectedVersion: 2 }]
      },
      {
        ...edit,
        corrections: [
          { axis: "git", action: "reset", expectedVersion: 1 },
          { axis: "git", action: "reset", expectedVersion: 1 }
        ]
      }
    ])
      await expect(
        preload.manageSourceContext!({
          action: "organize",
          sessionId,
          edit: bad
        } as never)
      ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(
      preload.manageSourceContext!({
        action: "organize",
        sessionId: validationId(101),
        edit
      })
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
