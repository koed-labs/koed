import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const watcherWakePath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(
    path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed")),
    "run",
    "codex-transcript-watcher.wake"
  );

export const signalCodexTranscriptWatcher = (
  env: NodeJS.ProcessEnv = process.env
): void => {
  try {
    const wakePath = watcherWakePath(env);
    mkdirSync(path.dirname(wakePath), { recursive: true, mode: 0o700 });
    writeFileSync(wakePath, `${Date.now()}\n`, { mode: 0o600 });
  } catch {
    // Wake delivery is best effort; periodic rescans own correctness.
  }
};
