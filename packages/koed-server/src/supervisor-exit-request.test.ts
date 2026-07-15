import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveKoedServerPaths } from "./paths.js";
import {
  monitorSupervisorExitRequest,
  requestSupervisorExit,
  supervisorExitRequestPath
} from "./supervisor-exit-request.js";

describe("supervisor exit requests", () => {
  it("exits only for a matching pid and startup identity", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-supervisor-exit-"));
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    let checks: (() => void) | undefined;
    let exits = 0;
    try {
      const stop = monitorSupervisorExitRequest(
        paths,
        { pid: 100, startedAt: "current" },
        {
          setInterval: ((callback: () => void) => {
            checks = callback;
            return { unref: () => undefined };
          }) as never,
          clearInterval: (() => undefined) as never,
          onExit: () => {
            exits += 1;
          }
        }
      );

      requestSupervisorExit(paths, { pid: 100, startedAt: "stale" });
      checks?.();
      expect(exits).toBe(0);

      requestSupervisorExit(paths, { pid: 100, startedAt: "current" });
      checks?.();
      expect(exits).toBe(1);
      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores malformed requests", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-supervisor-exit-"));
    const paths = resolveKoedServerPaths({ KOED_HOME: root });
    let exits = 0;
    try {
      requestSupervisorExit(paths, { pid: 100, startedAt: "current" });
      writeFileSync(supervisorExitRequestPath(paths), "not-json");
      const stop = monitorSupervisorExitRequest(
        paths,
        { pid: 100, startedAt: "current" },
        {
          setInterval: (() => ({ unref: () => undefined })) as never,
          clearInterval: (() => undefined) as never,
          onExit: () => {
            exits += 1;
          }
        }
      );

      expect(exits).toBe(0);
      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
