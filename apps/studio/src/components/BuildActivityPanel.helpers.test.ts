import { describe, expect, it } from "vitest";
import {
  boundBuildPanelWidth,
  MAX_BUILD_PANEL_WIDTH,
  MIN_BUILD_PANEL_WIDTH
} from "./BuildActivityPanel.helpers";

describe("BuildActivityPanel width helpers", () => {
  it("keeps the panel within its global bounds", () => {
    expect(boundBuildPanelWidth(120)).toBe(MIN_BUILD_PANEL_WIDTH);
    expect(boundBuildPanelWidth(900)).toBe(MAX_BUILD_PANEL_WIDTH);
  });

  it("leaves room for the chat content", () => {
    expect(boundBuildPanelWidth(500, 800)).toBe(440);
    expect(boundBuildPanelWidth(500, 650)).toBe(MIN_BUILD_PANEL_WIDTH);
  });
});
