import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  type Dirent,
  type FSWatcher
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemoryApiClient, defaultConfig } from "./index.js";
import {
  claudeProjectsHome,
  discoverClaudeTranscriptSignals
} from "./claude-transcript-discovery.js";
import { isTransientWatcherFilesystemError } from "./claude-transcript-source.js";
import { processClaudeTranscriptSignal } from "./claude-transcript-capture.js";
import {
  claudeWatcherSignalDirectory,
  claudeWatcherWakePath,
  type ClaudeTranscriptWatcherSignal
} from "./claude-transcript-watcher-signal.js";
import type { ClaudeWatcherState } from "./claude-transcript-types.js";

export type { ClaudeWatcherState } from "./claude-transcript-types.js";
export {
  discoverAllClaudeHistoricalTranscriptSignals,
  discoverClaudeHistoricalTranscriptSignals,
  discoverClaudeTranscriptSignals
} from "./claude-transcript-discovery.js";
export { registerClaudeHistoricalTranscriptSources } from "./claude-transcript-source.js";
export { processClaudeTranscriptSignal } from "./claude-transcript-capture.js";

export interface ClaudeTranscriptWatcherHandle {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

const statePath = (env: NodeJS.ProcessEnv): string =>
  path.join(
    path.resolve(env.KOED_HOME ?? path.join(os.homedir(), ".koed")),
    "state",
    "claude-transcript-watcher.json"
  );

const loadState = (env: NodeJS.ProcessEnv): ClaudeWatcherState => {
  try {
    const value = JSON.parse(readFileSync(statePath(env), "utf8")) as
      | ClaudeWatcherState
      | undefined;
    if (
      value?.version === 2 &&
      Number.isFinite(Date.parse(value.activatedAt))
    ) {
      return value;
    }
  } catch {
    // A missing state file creates a new activation frontier.
  }
  return { version: 2, activatedAt: new Date().toISOString(), cursors: {} };
};

const persistState = (env: NodeJS.ProcessEnv, state: ClaudeWatcherState) => {
  const target = statePath(env);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
};

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
};

export const startClaudeTranscriptWatcher = (
  client: MemoryApiClient = new MemoryApiClient(defaultConfig()),
  env: NodeJS.ProcessEnv = process.env
): ClaudeTranscriptWatcherHandle => {
  const state = loadState(env);
  persistState(env, state);
  const directory = claudeWatcherSignalDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let running: Promise<void> | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let retryNeedsDiscovery = false;
  let stopped = false;
  const debounceMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_DEBOUNCE_MS,
    200,
    25,
    5_000
  );
  const retryBaseMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_RETRY_BASE_MS,
    1_000,
    100,
    30_000
  );
  const retryMaxMs = boundedInteger(
    env.MEMORY_CLAUDE_TRANSCRIPT_RETRY_MAX_MS,
    30_000,
    retryBaseMs,
    5 * 60_000
  );
  let discoverPending = false;
  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    const delayMs = Math.min(
      retryMaxMs,
      retryBaseMs * 2 ** Math.min(retryAttempt, 8)
    );
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const discover = retryNeedsDiscovery;
      retryNeedsDiscovery = false;
      discoverPending ||= discover;
      scanInBackground(discover);
    }, delayMs);
    retryTimer.unref();
  };
  const scan = (discover: boolean): Promise<void> => {
    discoverPending ||= discover;
    if (running) return running;
    let failed = false;
    running = (async () => {
      do {
        const includeDiscovery = discoverPending;
        discoverPending = false;
        const signalled: Array<{
          signal: ClaudeTranscriptWatcherSignal;
          target?: string;
        }> = [];
        for (const name of await readdir(directory)) {
          if (!name.endsWith(".json")) continue;
          const target = path.join(directory, name);
          try {
            signalled.push({
              signal: JSON.parse(
                readFileSync(target, "utf8")
              ) as ClaudeTranscriptWatcherSignal,
              target
            });
          } catch (error) {
            try {
              renameSync(target, `${target}.invalid`);
            } catch {
              // A concurrent valid rewrite will be handled by the next wake.
            }
            console.error(
              `Claude transcript signal could not be read: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        if (includeDiscovery) {
          for (const signal of await discoverClaudeTranscriptSignals(
            state,
            env
          )) {
            signalled.push({ signal });
          }
        }
        for (const pending of signalled) {
          try {
            await processClaudeTranscriptSignal(
              client,
              state,
              pending.signal,
              env
            );
            persistState(env, state);
            if (pending.target) unlinkSync(pending.target);
          } catch (error) {
            failed = true;
            retryNeedsDiscovery ||= pending.target === undefined;
            console.error(
              `Claude transcript capture failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      } while (discoverPending);
    })().finally(() => {
      running = null;
      if (failed) {
        scheduleRetry();
      } else {
        retryAttempt = 0;
        retryNeedsDiscovery = false;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      }
    });
    return running;
  };
  const scanInBackground = (discover: boolean): void => {
    void scan(discover).catch((error) => {
      retryNeedsDiscovery ||= discover;
      console.error(
        `Claude transcript scan failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      scheduleRetry();
    });
  };
  const scanNow = (): Promise<void> => scan(false);
  const scheduleScan = (discover: boolean): void => {
    if (stopped) return;
    discoverPending ||= discover;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanInBackground(discover);
    }, debounceMs);
    debounceTimer.unref();
  };
  const watchers: FSWatcher[] = [];
  watchers.push(watch(directory, () => scheduleScan(false)));
  const wake = claudeWatcherWakePath(env);
  mkdirSync(path.dirname(wake), { recursive: true, mode: 0o700 });
  if (!existsSync(wake)) writeFileSync(wake, "0\n", { mode: 0o600 });
  watchers.push(watch(wake, () => scheduleScan(false)));
  const projectsHome = claudeProjectsHome(env);
  mkdirSync(projectsHome, { recursive: true, mode: 0o700 });
  const projectWatchers = new Map<string, FSWatcher>();
  const nestedWatchers = new Map<string, FSWatcher>();
  let refreshRunning: Promise<void> | null = null;
  let refreshPending = false;
  const refreshProjectWatchersPass = async (): Promise<void> => {
    const projects = (await readdir(projectsHome, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, 1_000);
    const current = new Set(projects.map((entry) => entry.name));
    for (const [name, watcher] of projectWatchers) {
      if (current.has(name)) continue;
      watcher.close();
      projectWatchers.delete(name);
    }
    for (const project of projects) {
      if (stopped || projectWatchers.has(project.name)) continue;
      try {
        projectWatchers.set(
          project.name,
          watch(path.join(projectsHome, project.name), requestWatcherRefresh)
        );
      } catch (error) {
        if (!isTransientWatcherFilesystemError(error)) throw error;
      }
    }
    const nested = new Set<string>();
    for (const project of projects) {
      const projectPath = path.join(projectsHome, project.name);
      let sessionDirectories: Dirent[];
      try {
        sessionDirectories = (
          await readdir(projectPath, { withFileTypes: true })
        )
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .slice(0, 10_000);
      } catch (error) {
        if (isTransientWatcherFilesystemError(error)) continue;
        throw error;
      }
      for (const sessionDirectory of sessionDirectories) {
        const sessionPath = path.join(projectPath, sessionDirectory.name);
        nested.add(sessionPath);
        const subagentPath = path.join(sessionPath, "subagents");
        try {
          const details = await lstat(subagentPath);
          if (details.isDirectory() && !details.isSymbolicLink()) {
            nested.add(subagentPath);
          }
        } catch {
          // The subagent directory is created lazily.
        }
      }
    }
    for (const [target, watcher] of nestedWatchers) {
      if (nested.has(target)) continue;
      watcher.close();
      nestedWatchers.delete(target);
    }
    for (const target of nested) {
      if (stopped || nestedWatchers.has(target)) continue;
      try {
        nestedWatchers.set(target, watch(target, requestWatcherRefresh));
      } catch (error) {
        if (!isTransientWatcherFilesystemError(error)) throw error;
      }
    }
  };
  const refreshProjectWatchers = (): Promise<void> => {
    refreshPending = true;
    if (refreshRunning) return refreshRunning;
    refreshRunning = (async () => {
      while (!stopped && refreshPending) {
        refreshPending = false;
        try {
          await refreshProjectWatchersPass();
        } catch (error) {
          console.error(
            `Claude project watcher refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    })().finally(() => {
      refreshRunning = null;
    });
    return refreshRunning;
  };
  function requestWatcherRefresh(): void {
    if (stopped) return;
    void refreshProjectWatchers().then(
      () => scheduleScan(true),
      (error) => {
        console.error(
          `Claude project watcher refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        scheduleScan(true);
      }
    );
  }
  watchers.push(watch(projectsHome, requestWatcherRefresh));
  requestWatcherRefresh();
  return {
    scanNow,
    async stop() {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      watchers.forEach((watcher) => watcher.close());
      projectWatchers.forEach((watcher) => watcher.close());
      nestedWatchers.forEach((watcher) => watcher.close());
      await running;
      await refreshRunning;
    }
  };
};
