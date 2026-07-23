import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { capSupervisorLog, maintainSupervisorLog } from "./supervisor-log.js";

describe("supervisor log retention", () => {
  it("truncates logs that exceed the configured bound", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-supervisor-log-"));
    const logPath = resolve(root, "supervisor.log");
    try {
      writeFileSync(logPath, "x".repeat(128));

      expect(capSupervisorLog(logPath, 64)).toBe(true);
      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain("exceeded 64 bytes and was truncated");
      expect(contents).not.toContain("x".repeat(64));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks the active daemon log periodically", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-supervisor-log-"));
    const logPath = resolve(root, "supervisor.log");
    let scheduled: (() => void) | undefined;
    let cleared = false;
    try {
      writeFileSync(logPath, "small");
      const stop = maintainSupervisorLog(
        { KOED_SERVER_SUPERVISOR_LOG_PATH: logPath },
        {
          maxBytes: 8,
          setInterval: ((callback: () => void) => {
            scheduled = callback;
            return { unref: () => undefined };
          }) as never,
          clearInterval: (() => {
            cleared = true;
          }) as never
        }
      );

      writeFileSync(logPath, "too-large");
      scheduled?.();
      expect(readFileSync(logPath, "utf8")).toContain("was truncated");
      stop();
      expect(cleared).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
