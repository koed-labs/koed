import { describe, expect, it } from "vitest";
import {
  boundStudioSidebarWidth,
  MAX_STUDIO_SIDEBAR_WIDTH,
  MIN_STUDIO_SIDEBAR_WIDTH
} from "./StudioSidebar.helpers";

describe("StudioSidebar width helper", () => {
  it("keeps the navigation within its global bounds", () => {
    expect(boundStudioSidebarWidth(100)).toBe(MIN_STUDIO_SIDEBAR_WIDTH);
    expect(boundStudioSidebarWidth(900)).toBe(MAX_STUDIO_SIDEBAR_WIDTH);
  });

  it("leaves room for the icon rail, divider, and content", () => {
    expect(boundStudioSidebarWidth(500, 1000)).toBe(420);
    expect(boundStudioSidebarWidth(400, 780)).toBe(220);
  });
});
