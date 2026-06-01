import { describe, expect, it } from "vitest";
import {
  resolveMcpLogDestinationConfig,
  resolveMcpLogLevel
} from "../src/logger.js";

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

  it("logs to stderr by default", () => {
    expect(resolveMcpLogDestinationConfig({} as NodeJS.ProcessEnv)).toEqual({
      destination: "stderr"
    });
  });

  it("uses a file destination when MEMORY_LOG_FILE is set", () => {
    const config = resolveMcpLogDestinationConfig({
      MEMORY_LOG_FILE: "logs/koed-mcp.log"
    } as NodeJS.ProcessEnv);

    expect(config.destination).toBe("file");
    expect(config.filePath).toContain("logs/koed-mcp.log");
  });

  it("supports explicitly mirroring logs to stderr and file", () => {
    expect(
      resolveMcpLogDestinationConfig({
        MEMORY_LOG_DESTINATION: "both",
        MEMORY_LOG_FILE: "/tmp/koed-mcp.log"
      } as NodeJS.ProcessEnv)
    ).toEqual({
      destination: "both",
      filePath: "/tmp/koed-mcp.log"
    });
  });

  it("falls back to stderr when file output lacks a file path", () => {
    expect(
      resolveMcpLogDestinationConfig({
        MEMORY_LOG_DESTINATION: "file"
      } as NodeJS.ProcessEnv)
    ).toEqual({ destination: "stderr" });
  });
});
