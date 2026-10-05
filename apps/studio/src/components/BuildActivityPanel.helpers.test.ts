import { describe, expect, it } from "vitest";
import {
  boundBuildPanelWidth,
  canShowCompactBuildCard,
  MAX_BUILD_PANEL_WIDTH,
  MIN_BUILD_PANEL_WIDTH
} from "./BuildActivityPanel.helpers";

describe("BuildActivityPanel width helpers", () => {
  it("shows the compact card with a sidebar open without requiring a 1280px chat area", () => {
    expect(canShowCompactBuildCard(1080)).toBe(true);
    expect(canShowCompactBuildCard(660)).toBe(true);
    expect(canShowCompactBuildCard(659)).toBe(false);
  });
  it("keeps the panel within its global bounds", () => {
    expect(boundBuildPanelWidth(120)).toBe(MIN_BUILD_PANEL_WIDTH);
    expect(boundBuildPanelWidth(900)).toBe(MAX_BUILD_PANEL_WIDTH);
  });

  it("leaves room for the chat content", () => {
    expect(boundBuildPanelWidth(500, 800)).toBe(440);
    expect(boundBuildPanelWidth(500, 650)).toBe(MIN_BUILD_PANEL_WIDTH);
  });
});
