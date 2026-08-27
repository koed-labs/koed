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
});
