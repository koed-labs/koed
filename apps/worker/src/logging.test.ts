import { describe, expect, it } from "vitest";
import {
  resolveWorkerLogDestinationConfig,
  resolveWorkerLogLevel
} from "./logging.js";

describe("worker logging", () => {
  it("uses WORKER_LOG_LEVEL", () => {
    expect(
      resolveWorkerLogLevel({
        WORKER_LOG_LEVEL: "error"
      } as NodeJS.ProcessEnv)
    ).toBe("error");
  });

  it("does not read MEMORY_LOG_LEVEL", () => {
    expect(
      resolveWorkerLogLevel({
        MEMORY_LOG_LEVEL: "debug"
      } as NodeJS.ProcessEnv)
    ).toBe("info");
  });

  it("falls back safely for invalid values", () => {
    expect(
      resolveWorkerLogLevel({
        WORKER_LOG_LEVEL: "verbose"
      } as NodeJS.ProcessEnv)
    ).toBe("info");
  });

  it("stays silent by default under tests", () => {
    expect(
      resolveWorkerLogLevel({
        NODE_ENV: "test"
      } as NodeJS.ProcessEnv)
    ).toBe("silent");
  });

  it("logs to stderr by default", () => {
    expect(resolveWorkerLogDestinationConfig({} as NodeJS.ProcessEnv)).toEqual({
      destination: "stderr"
    });
  });

  it("uses a file destination when WORKER_LOG_FILE is set", () => {
    const config = resolveWorkerLogDestinationConfig({
      WORKER_LOG_FILE: "logs/koed-worker.log"
    } as NodeJS.ProcessEnv);

    expect(config.destination).toBe("file");
    expect(config.filePath).toContain("logs/koed-worker.log");
  });

  it("supports explicitly mirroring logs to stderr and file", () => {
    expect(
      resolveWorkerLogDestinationConfig({
        WORKER_LOG_DESTINATION: "both",
        WORKER_LOG_FILE: "/tmp/koed-worker.log"
      } as NodeJS.ProcessEnv)
    ).toEqual({
      destination: "both",
      filePath: "/tmp/koed-worker.log"
    });
  });

  it("falls back to stderr when file output lacks a file path", () => {
    expect(
      resolveWorkerLogDestinationConfig({
        WORKER_LOG_DESTINATION: "file"
      } as NodeJS.ProcessEnv)
    ).toEqual({ destination: "stderr" });
  });
});
