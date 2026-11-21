import type { SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startKoedServerDaemon } from "./daemon-start.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("standalone daemon entrypoint", () => {
  it("preserves external process.argv entrypoint on daemon start", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-daemon-start-"));
    roots.push(root);
    const originalArgv1 = process.argv[1]!;
    const spawns: Array<{ command: string; args: string[] }> = [];
    process.argv[1] = "/opt/koed/bin/koed";
    try {
      const result = startKoedServerDaemon({
        environment: { KOED_HOME: root },
        spawn: (command, args) => {
          if (!Array.isArray(args)) throw new Error("Expected spawn arguments");
          const argumentsList: unknown[] = args;
          if (
            !argumentsList.every(
              (value): value is string => typeof value === "string"
            )
          )
            throw new Error("Expected string spawn arguments");
          spawns.push({ command, args: argumentsList });
          return { pid: 224, unref: () => undefined } as never;
        }
      });
      expect(result.ok).toBe(true);
      expect(spawns).toEqual([
        { command: process.execPath, args: ["/opt/koed/bin/koed", "start"] }
      ]);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("forwards the caller's absolute environment file to the detached supervisor", () => {
    const root = mkdtempSync(resolve(tmpdir(), "koed-daemon-start-"));
    roots.push(root);
    const checkout = resolve(root, "checkout");
    const spawns: Array<{ cwd: unknown; env: NodeJS.ProcessEnv | undefined }> =
      [];
    const result = startKoedServerDaemon({
      environment: {
        KOED_HOME: root,
        KOED_REPO_ROOT: checkout,
        KOED_ENV_PATH: "operator.env"
      },
      startCommand: "/opt/koed/bin/koed",
      spawn: ((
        _command: string,
        _args: readonly string[],
        options: SpawnOptions
      ) => {
        spawns.push({ cwd: options.cwd, env: options.env });
        return { pid: 225, unref: () => undefined };
      }) as never
    });
    expect(result.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.cwd).toBe(checkout);
    expect(spawns[0]?.env?.KOED_ENV_PATH).toBe(
      resolve(process.cwd(), "operator.env")
    );
  });
});
