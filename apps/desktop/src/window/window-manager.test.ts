import { describe, expect, it } from "vitest";

import { createMainWindowOptions } from "./window-manager.js";

describe("Desktop main window security", () => {
  it("isolates and sandboxes the renderer without Node access", () => {
    const options = createMainWindowOptions("/opt/koed/desktop");

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    });
    expect(options.webPreferences?.preload).toBe(
      "/opt/koed/desktop/preload.cjs"
    );
    expect(options.webPreferences).not.toHaveProperty("enableRemoteModule");
  });

  it("uses the supplied theme color before renderer paint", () => {
    expect(
      createMainWindowOptions("/opt/koed/desktop", undefined, "#181817")
        .backgroundColor
    ).toBe("#181817");
  });
});
