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
  watcherWakePath
} from "../src/codex-transcript-watcher-signal.js";

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

  it("does not block the AI Client when wake delivery fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "koed-hook-"));
    temporaryDirectories.push(root);
    const notADirectory = path.join(root, "not-a-directory");
    fs.writeFileSync(notADirectory, "occupied");

    expect(() => signalCaptureHook({ KOED_HOME: notADirectory })).not.toThrow();
  });
});
