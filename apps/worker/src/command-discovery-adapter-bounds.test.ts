import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  type Dir,
  type Dirent
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({
  entries: 0,
  opened: 0,
  closed: 0,
  metadataReads: 0,
  abortedReads: 0,
  fileStats: 0,
  signals: [] as (AbortSignal | undefined)[],
  gate: undefined as
    | undefined
    | {
        started: () => void;
        released: Promise<void>;
        settled: () => void;
        expectedRoots: number;
        pausedRoots: number;
        stage: "directory" | "metadata" | "realpath" | "stat";
      }
}));

async function pauseDirectory() {
  if (scan.gate?.stage !== "directory") return;
  scan.gate.pausedRoots++;
  if (scan.gate.pausedRoots === scan.gate.expectedRoots) scan.gate.started();
  await scan.gate.released;
}

function observeDirectory(directory: Dir): Dir {
  scan.opened++;
  const promiseDirectory: {
    read: () => Promise<Dirent | null>;
    close: () => Promise<void>;
  } = directory;
  const read = promiseDirectory.read.bind(directory);
  const close = promiseDirectory.close.bind(directory);
  vi.spyOn(promiseDirectory, "read").mockImplementation(async () => {
    const entry = await read();
    if (entry) scan.entries++;
    await pauseDirectory();
    return entry;
  });
  vi.spyOn(promiseDirectory, "close").mockImplementation(async () => {
    await close();
    scan.closed++;
    if (
      scan.gate?.stage === "directory" &&
      scan.closed === scan.gate.expectedRoots
    )
      scan.gate.settled();
  });
  return directory;
}

function validationObservers(actual: typeof import("node:fs/promises")) {
  return {
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = await actual.realpath(...args);
      if (
        scan.gate?.stage === "realpath" &&
        String(args[0]).endsWith("review.md")
      ) {
        scan.gate.started();
        await scan.gate.released;
        scan.gate.settled();
      }
      return path;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const commandFile = String(args[0]).endsWith("review.md");
      if (commandFile) scan.fileStats++;
      const info = await actual.stat(...args);
      if (scan.gate?.stage === "stat" && commandFile) {
        scan.gate.started();
        await scan.gate.released;
        scan.gate.settled();
      }
      return info;
    }
  };
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    ...validationObservers(actual),
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args);
      scan.entries += entries.length;
      await pauseDirectory();
      return entries;
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) =>
      observeDirectory(await actual.opendir(...args)),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      scan.metadataReads++;
      const options = args[1];
      scan.signals.push(
        typeof options === "object" ? options?.signal : undefined
      );
      if (scan.gate?.stage === "metadata") {
        scan.gate.started();
        await scan.gate.released;
      }
      try {
        return await actual.readFile(...args);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError")
          scan.abortedReads++;
        throw error;
      } finally {
        if (scan.metadataReads === scan.gate?.expectedRoots)
          scan.gate.settled();
      }
    }
  };
});

import { createCommandDiscoveryAdapter } from "./command-discovery-adapter.js";

const temporaryRoots: string[] = [];
const fixture = (withProject = false) => {
  const root = mkdtempSync(join(tmpdir(), "koed-discovery-bounds-"));
  temporaryRoots.push(root);
  const configHome = join(root, "config");
  const promptRoot = join(configHome, "prompts");
  mkdirSync(promptRoot, { recursive: true });
  const executable = join(root, "client");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const registry = join(root, "instances.json");
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      instances: [
        {
          instanceId: "codex.fixture",
          driverId: "codex",
          displayName: "Fixture",
          executablePath: executable,
          configHome
        }
      ]
    })
  );
  const projectRoot = withProject ? join(root, "project") : undefined;
  if (projectRoot)
    mkdirSync(join(projectRoot, ".codex", "prompts"), { recursive: true });
  return {
    promptRoot,
    projectRoot,
    adapter: createCommandDiscoveryAdapter("codex", {
      KOED_AI_CLIENT_INSTANCE_REGISTRY: registry
    }),
    args: {
      aiClientInstanceId: "codex.fixture",
      ...(projectRoot ? { projectRoot } : {})
    }
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const pauseScan = (
  stage: "directory" | "metadata" | "realpath" | "stat",
  expectedRoots: number
) => {
  const started = deferred();
  const released = deferred();
  const settled = deferred();
  scan.gate = {
    started: started.resolve,
    released: released.promise,
    settled: settled.resolve,
    expectedRoots,
    pausedRoots: 0,
    stage
  };
  return {
    started: started.promise,
    release: released.resolve,
    settled: settled.promise
  };
};

afterEach(() => {
  vi.useRealTimers();
  scan.entries =
    scan.opened =
    scan.closed =
    scan.metadataReads =
    scan.abortedReads =
      0;
  scan.fileStats = 0;
  scan.signals = [];
  scan.gate = undefined;
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("bounded file command discovery", () => {
  it.each(["non-command files", "nested directories", "rejected commands"])(
    "counts %s against the root-wide entry budget",
    async (kind) => {
      const { promptRoot, adapter, args } = fixture();
      for (let index = 0; index < 400; index++) {
        const directory =
          kind === "nested directories"
            ? join(promptRoot, `group-${Math.floor(index / 20)}`)
            : promptRoot;
        mkdirSync(directory, { recursive: true });
        const name =
          kind === "rejected commands"
            ? `bad name ${index}.md`
            : `${index}.txt`;
        writeFileSync(join(directory, name), "Ignored metadata.");
      }
      await expect(adapter.discoverCommands(args)).resolves.toEqual([]);
      expect(scan.entries).toBeLessThanOrEqual(256);
      expect(scan.entries).toBe(256);
      expect(scan.closed).toBe(scan.opened);
    }
  );

  it("retains admitted commands when descendants exhaust the entry budget", async () => {
    const { promptRoot, adapter, args } = fixture();
    const noiseRoot = join(promptRoot, "noise");
    mkdirSync(noiseRoot);
    for (let index = 0; index < 200; index++) {
      writeFileSync(join(promptRoot, `${index}.txt`), "Ignored.");
      writeFileSync(join(noiseRoot, `${index}.txt`), "Ignored.");
    }
    writeFileSync(join(promptRoot, "review.md"), "Review command.");
    writeFileSync(join(promptRoot, "test.md"), "Test command.");
    const commands = await adapter.discoverCommands(args);
    expect(commands.map((command) => command.name)).toEqual(["review", "test"]);
    expect(scan.entries).toBe(256);
    expect(scan.closed).toBe(scan.opened);
  });

  it.each(["realpath", "stat"] as const)(
    "schedules no more metadata work after a timed-out %s call finishes",
    async (stage) => {
      const { promptRoot, adapter, args } = fixture();
      writeFileSync(join(promptRoot, "review.md"), "Review command.");
      const gate = pauseScan(stage, 1);
      vi.useFakeTimers();
      const discovery = adapter.discoverCommands(args);
      try {
        await gate.started;
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(discovery).resolves.toEqual([]);
        gate.release();
        await gate.settled;
        await vi.advanceTimersByTimeAsync(0);
        expect(scan.fileStats).toBe(stage === "stat" ? 1 : 0);
        expect(scan.metadataReads).toBe(0);
        expect(scan.closed).toBe(scan.opened);
      } finally {
        gate.release();
      }
    }
  );

  it.each([false, true])(
    "stops every root and closes directory handles after timeout (Project: %s)",
    async (withProject) => {
      const { promptRoot, projectRoot, adapter, args } = fixture(withProject);
      writeFileSync(join(promptRoot, "review.md"), "Review command.");
      if (projectRoot)
        writeFileSync(
          join(projectRoot, ".codex", "prompts", "test.md"),
          "Test command."
        );
      const gate = pauseScan("directory", withProject ? 2 : 1);
      vi.useFakeTimers();
      const discovery = adapter.discoverCommands(args);
      try {
        await gate.started;
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(discovery).resolves.toEqual([]);
        gate.release();
        await gate.settled;
        expect(scan.metadataReads).toBe(0);
        expect(scan.closed).toBe(withProject ? 2 : 1);
        expect(scan.closed).toBe(scan.opened);
      } finally {
        gate.release();
      }
    }
  );

  it("passes timeout cancellation to a delayed metadata read", async () => {
    const { promptRoot, adapter, args } = fixture();
    writeFileSync(join(promptRoot, "review.md"), "Review command.");
    const gate = pauseScan("metadata", 1);
    vi.useFakeTimers();
    const discovery = adapter.discoverCommands(args);
    try {
      await gate.started;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(discovery).resolves.toEqual([]);
      gate.release();
      await gate.settled;
      expect(scan.signals[0]?.aborted).toBe(true);
      expect(scan.abortedReads).toBe(1);
      expect(scan.metadataReads).toBe(1);
      expect(scan.closed).toBe(scan.opened);
    } finally {
      gate.release();
    }
  });
});
