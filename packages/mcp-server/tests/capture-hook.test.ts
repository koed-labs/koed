import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureHookEnvironment,
  signalCaptureHook
} from "../src/capture-hook.js";
import {
  readCodexTranscriptTurnBoundary,
  signalCodexTranscriptWatcher,
  watcherWakePath
} from "../src/codex-transcript-watcher-signal.js";
import { claudeWatcherSignalDirectory } from "../src/claude-transcript-watcher-signal.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex Capture Hook signal", () => {
  it("routes isolated installations to their explicit Koed home", () => {
    const koedHome = path.join(os.tmpdir(), "koed home");

    expect(
      captureHookEnvironment({ KOED_HOME: "/wrong/home" }, [
        "--koed-home",
        koedHome
      ])
    ).toMatchObject({ KOED_HOME: path.resolve(koedHome) });
  });

  it("writes only a private wake signal under KOED_HOME", () => {
    const koedHome = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(koedHome);
    const environment = {
      KOED_HOME: koedHome,
      MEMORY_API_TOKEN: "must-not-be-written",
      WORKOS_API_KEY: "must-not-be-written"
    };

    signalCaptureHook(environment);

    const wakePath = watcherWakePath(environment);
    expect(fs.readFileSync(wakePath, "utf8")).toMatch(/^\d+\n$/);
    expect(fs.readFileSync(wakePath, "utf8")).not.toContain("must-not");
    expect(fs.statSync(wakePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(wakePath)).mode & 0o777).toBe(0o700);
  });

  it("records only hashed routing identities for a transcript turn boundary", () => {
    const koedHome = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(koedHome);
    const environment = { KOED_HOME: koedHome };
    const transcriptPath = path.join(koedHome, "private", "rollout.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "event_msg" })}\n`
    );

    signalCaptureHook(environment, {
      hookEventName: "Stop",
      sourceSessionId: "session-sensitive",
      transcriptPath
    });

    const boundary = readCodexTranscriptTurnBoundary(environment, {
      sourceSessionId: "session-sensitive",
      transcriptPath
    });
    expect(typeof boundary?.observedAt).toBe("number");
    expect(boundary?.sourceOffset).toBe(fs.statSync(transcriptPath).size);
    const directory = path.join(koedHome, "run", "codex-transcript-boundaries");
    const stored = fs
      .readdirSync(directory)
      .map((name) => `${name}\n${fs.readFileSync(path.join(directory, name))}`)
      .join("\n");
    expect(stored).not.toContain("session-sensitive");
    expect(stored).not.toContain("rollout.jsonl");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("publishes a transcript turn boundary before its watcher wake", () => {
    const koedHome = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(koedHome);
    const environment = { KOED_HOME: koedHome };
    const transcriptPath = path.join(koedHome, "private", "rollout.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "event_msg" })}\n`
    );
    const writes: Array<{ target: string; content: string }> = [];

    signalCodexTranscriptWatcher(
      environment,
      {
        sourceSessionId: "session-sensitive",
        transcriptPath,
        turnBoundary: true
      },
      (target, content) => writes.push({ target, content })
    );

    expect(writes).toHaveLength(3);
    expect(
      writes
        .slice(0, -1)
        .every(({ content }) => content.includes('"version":2'))
    ).toBe(true);
    expect(writes.at(-1)?.target).toBe(watcherWakePath(environment));
  });

  it("does not block the AI Client when wake delivery fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(root);
    const notADirectory = path.join(root, "not-a-directory");
    fs.writeFileSync(notADirectory, "occupied");

    expect(() => signalCaptureHook({ KOED_HOME: notADirectory })).not.toThrow();
  });

  it("routes Claude hooks to the Claude watcher without creating a Codex wake", () => {
    const koedHome = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(koedHome);
    const environment = { KOED_HOME: koedHome };

    signalCaptureHook(
      environment,
      {
        hookEventName: "PostToolUse",
        sourceSessionId: "claude-session",
        transcriptPath: path.join(
          os.homedir(),
          ".claude",
          "projects",
          "project",
          "claude-session.jsonl"
        ),
        cwd: "/tmp/project"
      },
      ["--source", "claude"]
    );

    const signalFiles = fs.readdirSync(
      claudeWatcherSignalDirectory(environment)
    );
    expect(signalFiles).toHaveLength(1);
    expect(fs.existsSync(watcherWakePath(environment))).toBe(false);
    const signal: unknown = JSON.parse(
      fs.readFileSync(
        path.join(claudeWatcherSignalDirectory(environment), signalFiles[0]!),
        "utf8"
      )
    );
    expect(signal).toMatchObject({
      sourceSessionId: "claude-session",
      hookEventName: "PostToolUse",
      cwd: "/tmp/project"
    });
  });

  it("preserves a Claude turn boundary while later wakes are coalesced", () => {
    const koedHome = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(koedHome);
    const environment = { KOED_HOME: koedHome };
    const metadata = {
      sourceSessionId: "claude-session",
      transcriptPath: path.join(
        os.homedir(),
        ".claude",
        "projects",
        "project",
        "claude-session.jsonl"
      ),
      cwd: "/tmp/project"
    };

    signalCaptureHook(environment, { ...metadata, hookEventName: "Stop" }, [
      "--source",
      "claude"
    ]);
    signalCaptureHook(
      environment,
      { ...metadata, hookEventName: "PostToolUse" },
      ["--source", "claude"]
    );

    const [name] = fs.readdirSync(claudeWatcherSignalDirectory(environment));
    const signal: unknown = JSON.parse(
      fs.readFileSync(
        path.join(claudeWatcherSignalDirectory(environment), name!),
        "utf8"
      )
    );
    expect(signal).toMatchObject({
      hookEventName: "PostToolUse",
      turnBoundary: true
    });
  });
});
