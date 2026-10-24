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
          spawns.push({ command, args });
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
});
