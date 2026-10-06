import { describe, expect, it } from "vitest";
import { createDesktopSupervisorEnvironment } from "./desktop-supervisor-entrypoint.js";

describe("Desktop supervisor environment", () => {
  it("removes inherited resource-path authority", () => {
    const environment = createDesktopSupervisorEnvironment({
      KOED_PACKAGED_RESOURCES_PATH: "/untrusted/resources",
      KOED_HOME: "/operator/home"
    });
    expect(environment.KOED_PACKAGED_RESOURCES_PATH).toBeUndefined();
    expect(environment.KOED_PACKAGED_DESKTOP).toBe("1");
    expect(environment.KOED_HOME).toBe("/operator/home");
  });
});
