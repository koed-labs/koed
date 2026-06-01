import { describe, expect, it } from "vitest";
import { resolveMcpLogLevel } from "../src/logger.js";

describe("MCP logger", () => {
  it("uses MEMORY_LOG_LEVEL", () => {
    expect(
      resolveMcpLogLevel({
        MEMORY_LOG_LEVEL: "error"
      } as NodeJS.ProcessEnv)
    ).toBe("error");
  });

  it("does not read package-local LOG_LEVEL", () => {
    expect(
      resolveMcpLogLevel({
        LOG_LEVEL: "debug"
      } as NodeJS.ProcessEnv)
    ).toBe("info");
  });

  it("falls back safely for invalid values", () => {
    expect(
      resolveMcpLogLevel({
        MEMORY_LOG_LEVEL: "verbose"
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
