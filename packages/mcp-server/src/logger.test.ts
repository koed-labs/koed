import { describe, expect, it } from "vitest";
import { resolveMcpLogLevel } from "./logger.js";

describe("MCP logger", () => {
  it("uses LOG_LEVEL before MEMORY_LOG_LEVEL", () => {
    expect(
      resolveMcpLogLevel({
        LOG_LEVEL: "debug",
        MEMORY_LOG_LEVEL: "error"
      } as NodeJS.ProcessEnv)
    ).toBe("debug");
  });

  it("supports MEMORY_LOG_LEVEL as an MCP-specific fallback", () => {
    expect(
      resolveMcpLogLevel({
        MEMORY_LOG_LEVEL: "warn"
      } as NodeJS.ProcessEnv)
    ).toBe("warn");
  });

  it("falls back safely for invalid values", () => {
    expect(
      resolveMcpLogLevel({
        LOG_LEVEL: "verbose"
      } as NodeJS.ProcessEnv)
    ).toBe("info");
  });

  it("stays silent by default under tests", () => {
    expect(
      resolveMcpLogLevel({
        NODE_ENV: "test"
      } as NodeJS.ProcessEnv)
    ).toBe("silent");
  });
});
