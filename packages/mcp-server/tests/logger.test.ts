import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import {
  createMcpLogger,
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

  it("redacts retrieval hints and complete traces from logs", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    const sentinel = "PLAINTEXT_RETRIEVAL_HINT_LOG_SENTINEL";
    const testLogger = createMcpLogger("retrieval-redaction-test", {
      destination,
      environment: {
        NODE_ENV: "test",
        MEMORY_LOG_LEVEL: "info"
      } as NodeJS.ProcessEnv
    });
    testLogger.info({
      retrievalHints: { exact: [sentinel] },
      retrieval: { trace: { retrievalHints: { exact: [sentinel] } } },
      trace: { orderedErrors: [sentinel] }
    });

    expect(output).not.toContain(sentinel);
    expect(output).toContain("[Redacted]");
  });
  it("never serializes exception content and bounds hostile error metadata", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    const log = createMcpLogger("error-safety-test", {
      destination,
      environment: { MEMORY_LOG_LEVEL: "info", NODE_ENV: "test" }
    });
    const secret = "MEMORY_AND_CREDENTIAL_SENTINEL";
    const error = Object.assign(
      new Error(secret, { cause: new Error(secret) }),
      {
        status: 401,
        payload: { token: secret },
        details: secret.repeat(10000),
        code: secret
      }
    );
    log.warn({ err: error }, "operation failed");
    log.warn(error);
    log.warn(
      {
        error: JSON.parse(
          JSON.stringify({
            message: secret,
            stack: secret,
            cause: { token: secret },
            statusCode: 404
          })
        )
      },
      "request failed"
    );
    log.warn(
      {
        err: error,
        nested: { cause: error, message: secret },
        many: Array(1000).fill({ text: "x".repeat(10000) })
      },
      "bounded metadata"
    );
    expect(output).not.toContain(secret);
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines)
      expect(Buffer.byteLength(line)).toBeLessThan(8192);
    // The hostile `code` is not on the allowlist, so only safe fields remain.
    expect((JSON.parse(lines[0]!) as { err: unknown }).err).toEqual({
      type: "Error",
      name: "Error",
      status: 401,
      cause: { type: "Error", name: "Error" }
    });
  });
  it("keeps allowlisted error names and codes, including one cause level", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    const log = createMcpLogger("error-code-test", {
      destination,
      environment: { MEMORY_LOG_LEVEL: "info", NODE_ENV: "test" }
    });
    const refused = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:43123 PRIVATE_HOST_DETAIL"),
      { code: "ECONNREFUSED" }
    );
    log.warn({ err: new TypeError("fetch failed", { cause: refused }) }, "x");
    const renamed = Object.assign(new Error("PRIVATE"), {
      code: "PRIVATE_CODE_SENTINEL"
    });
    Object.defineProperty(renamed, "name", {
      value: "PrivateNameSentinelError"
    });
    log.warn({ err: renamed }, "x");
    const getterName = new Error("PRIVATE");
    Object.defineProperty(getterName, "name", {
      get: () => {
        throw new Error("PRIVATE_GETTER_SENTINEL");
      }
    });
    expect(() => log.warn({ err: getterName }, "x")).not.toThrow();
    const lines = output
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { err: unknown }).err);
    expect(lines[0]).toEqual({
      type: "Error",
      name: "TypeError",
      cause: { type: "Error", name: "Error", code: "ECONNREFUSED" }
    });
    expect(lines[1]).toEqual({ type: "Error" });
    expect(lines[2]).toEqual({ type: "Error" });
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("PrivateNameSentinelError");
  });
  it("adds bounded error messages and stacks only with KOED_LOG_ERROR_DETAIL=1", () => {
    const capture = (environment: NodeJS.ProcessEnv) => {
      let output = "";
      const destination = new Writable({
        write(chunk, _encoding, callback) {
          output += String(chunk);
          callback();
        }
      });
      const log = createMcpLogger("error-detail-test", {
        destination,
        environment: { MEMORY_LOG_LEVEL: "info", ...environment }
      });
      const error = new Error("DETAIL_MESSAGE " + "x".repeat(5000), {
        cause: new Error("DETAIL_CAUSE")
      });
      log.warn({ err: error }, "operation failed");
      return JSON.parse(output.trim()) as {
        err: { message?: string; stack?: string; cause?: { message?: string } };
      };
    };
    const off = capture({ KOED_LOG_ERROR_DETAIL: "true" });
    expect(off.err).not.toHaveProperty("message");
    expect(off.err).not.toHaveProperty("stack");
    const on = capture({ KOED_LOG_ERROR_DETAIL: "1" });
    expect(on.err.message).toMatch(/^DETAIL_MESSAGE x+$/);
    expect(on.err.message).toHaveLength(1024);
    expect(on.err.stack).toContain("DETAIL_MESSAGE");
    expect(on.err.stack!.length).toBeLessThanOrEqual(4096);
    expect(on.err.cause?.message).toBe("DETAIL_CAUSE");
  });
  it("does not invoke error getters, toJSON or cyclic causes", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    const log = createMcpLogger("hostile-error-test", {
      destination,
      environment: { MEMORY_LOG_LEVEL: "info" }
    });
    const getter = () => {
      throw new Error("SECRET_GETTER");
    };
    const error = Object.defineProperty(new Error("SECRET_ERROR"), "status", {
      get: getter
    });
    (error as Error & { cause: unknown }).cause = error;
    Object.assign(error, { toJSON: getter });
    expect(() => log.warn({ err: error }, "failed")).not.toThrow();
    expect(() =>
      log.warn(
        {
          err: {
            get statusCode() {
              return getter();
            },
            toJSON: getter
          }
        },
        "failed"
      )
    ).not.toThrow();
    expect(output).not.toContain("SECRET");
  });
});
