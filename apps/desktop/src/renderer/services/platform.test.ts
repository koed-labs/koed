// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../types.js";
import { createRendererPlatform } from "./platform.js";

afterEach(() => {
  delete window.koedDesktop;
});

describe("createRendererPlatform", () => {
  it("reveals a local Project by opaque identity rather than renderer path", async () => {
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValue({ ok: true });
    window.koedDesktop = { invoke } as DesktopApi;
    const localProjectId = `lp_${"1".repeat(32)}`;

    await expect(
      createRendererPlatform().revealLocalProject(localProjectId)
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("reveal_local_project", {
      localProjectId
    });
  });

  it("rejects malformed local Project identities before IPC", async () => {
    const invoke = vi.fn<DesktopApi["invoke"]>();
    window.koedDesktop = { invoke } as DesktopApi;

    await expect(
      createRendererPlatform().revealLocalProject(
        "/Applications/Calculator.app"
      )
    ).rejects.toThrow("Local Project identity is invalid");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("selects or cancels a Project through the fixed native operation", async () => {
    const metadata = {
      schemaVersion: 1 as const,
      discoveredAt: "2026-09-09T10:00:00.000Z",
      lastSeenAt: "2026-09-09T10:00:00.000Z",
      localProjectId: "lp_project",
      displayName: "Project",
      path: { cwd: "/tmp/project", projectRoot: null }
    };
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({
        canceled: false,
        result: {
          project: {
            ...metadata,
            path: {
              ...metadata.path,
              basename: "project",
              localPathHash: "hash"
            },
            packages: []
          }
        }
      })
      .mockResolvedValueOnce({
        project: {
          ...metadata,
          displayName: "Independent",
          path: {
            ...metadata.path,
            basename: "Independent",
            localPathHash: "hash"
          },
          packages: []
        }
      });
    window.koedDesktop = { invoke } as DesktopApi;
    const platform = createRendererPlatform();

    await expect(platform.selectProjectDirectory()).resolves.toBeNull();
    await expect(platform.selectProjectDirectory()).resolves.toEqual(metadata);
    await expect(platform.ensureIndependentProject()).resolves.toMatchObject({
      displayName: "Independent"
    });
    expect(invoke.mock.calls).toEqual([
      ["select_project_directory"],
      ["select_project_directory"],
      ["ensure_independent_project"]
    ]);
  });
});
