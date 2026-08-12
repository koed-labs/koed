import { describe, expect, it } from "vitest";

import { shouldQuitAfterAllWindowsClosed } from "./lifecycle.js";

describe("Desktop window lifecycle", () => {
  it("keeps the app running on Linux so the tray can reopen the window", () => {
    expect(shouldQuitAfterAllWindowsClosed("linux")).toBe(false);
  });

  it("keeps the existing macOS window lifecycle", () => {
    expect(shouldQuitAfterAllWindowsClosed("darwin")).toBe(false);
  });

  it("quits after the last window closes on Windows", () => {
    expect(shouldQuitAfterAllWindowsClosed("win32")).toBe(true);
  });
});
