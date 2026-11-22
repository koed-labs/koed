import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDeviceIdentity,
  readSourceFolderObservation,
  readCurrentSourceFolderObservation,
  readSourceRepositoryIdentity,
  resolveKoedServerPaths
} from "@koed-labs/server";
import { normalizeGitRemoteUrl } from "@koed-labs/shared";
import {
  recordCaptureHookFolder,
  signalCaptureHook
} from "../src/capture-hook.js";
import { recordedCaptureFolderObservation } from "../src/capture-repository-context.js";
import { claudeWatcherSignalDirectory } from "../src/claude-transcript-watcher-signal.js";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("native Capture Hook Folder evidence", () => {
  it.each(["codex", "claude"] as const)(
    "carries %s source-time identity and keeps later cwd observations separate",
    async (provider) => {
      const parent = resolve(
        import.meta.dirname,
        "../../../scratch/p1-06/hooks"
      );
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(resolve(parent, "capture-"));
      temporary.push(root);
      const env = {
        NODE_ENV: "test",
        KOED_HOME: resolve(root, "profile"),
        KOED_REPO_ROOT: root
      };
      const paths = resolveKoedServerPaths(env);
      await ensureDeviceIdentity(paths, { environment: env });
      const cwd = resolve(root, "checkout"),
        sub = resolve(cwd, "sub");
      mkdirSync(sub, { recursive: true });
      const args = ["--source", provider];
      const key = {
        sourceKind:
          provider === "codex" ? ("codex" as const) : ("claude-code" as const),
        externalSessionId: "native-session"
      };
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: key.externalSessionId,
          cwd,
          hookEventName: "SessionStart",
          sessionStartSource: "startup"
        },
        args
      );
      const original = readSourceFolderObservation(paths, key);
      expect(original?.normalizedPath).toBe(cwd);
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: key.externalSessionId,
          cwd: sub,
          hookEventName: "Stop"
        },
        args
      );
      expect(readSourceFolderObservation(paths, key)).toEqual(original);
      expect(
        readCurrentSourceFolderObservation(paths, key)?.normalizedPath
      ).toBe(sub);
      const unknown = { ...key, externalSessionId: "previously-uncaptured" };
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: unknown.externalSessionId,
          cwd: sub,
          hookEventName: "SessionStart",
          sessionStartSource: "resume"
        },
        args
      );
      expect(readSourceFolderObservation(paths, unknown)).toBeUndefined();
      rmSync(cwd, { recursive: true });
      expect(recordedCaptureFolderObservation({ ...key, env })).toEqual(
        original
      );
      expect(
        recordedCaptureFolderObservation({ ...unknown, env })
      ).toBeUndefined();
    }
  );
});

describe("Capture Hook new Conversation starts", () => {
  const setup = async () => {
    const parent = resolve(import.meta.dirname, "../../../scratch/p1-06/hooks");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(resolve(parent, "start-"));
    temporary.push(root);
    const env = {
      NODE_ENV: "test",
      KOED_HOME: resolve(root, "profile"),
      KOED_REPO_ROOT: root
    };
    const paths = resolveKoedServerPaths(env);
    await ensureDeviceIdentity(paths, { environment: env });
    const cwd = resolve(root, "checkout");
    mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    git("init");
    git("remote", "add", "origin", "git@example.test:team/capture-start.git");
    return { root, env, paths, cwd };
  };
  const forkTranscript = (
    root: string,
    sessionId: string,
    messages: Array<Record<string, unknown>>
  ) => {
    const transcriptPath = resolve(root, `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      [...messages, { type: "custom-title", customTitle: "Fork", sessionId }]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n"
    );
    return transcriptPath;
  };

  it.each([
    { provider: "codex", source: "startup" },
    { provider: "codex", source: "clear" },
    { provider: "claude", source: "startup" },
    { provider: "claude", source: "clear" }
  ] as const)(
    "pins the $provider Folder and portable Git remote on $source",
    async ({ provider, source }) => {
      const { env, paths, cwd } = await setup();
      const key = {
        sourceKind:
          provider === "codex" ? ("codex" as const) : ("claude-code" as const),
        externalSessionId: `new-${provider}-${source}`
      };
      await recordCaptureHookFolder(
        env,
        {
          sourceSessionId: key.externalSessionId,
          cwd,
          hookEventName: "SessionStart",
          sessionStartSource: source
        },
        ["--source", provider]
      );
      expect(readSourceFolderObservation(paths, key)?.normalizedPath).toBe(cwd);
      // ssh and https spellings share one portable fingerprint.
      expect(readSourceRepositoryIdentity(paths, key)).toMatchObject({
        kind: "portable_repository",
        key: normalizeGitRemoteUrl("https://example.test/team/capture-start")
          .fingerprint
      });
    }
  );

  it("observes and signals Claude Code resume without pinning copied fork history", async () => {
    const { root, env, paths, cwd } = await setup();
    const sessionId = "forked-session";
    const transcriptPath = forkTranscript(root, sessionId, [
      { type: "user", sessionId: "parent-session" },
      { type: "assistant", sessionId: "parent-session" },
      {
        type: "assistant",
        sessionId,
        message: { model: "<synthetic>" }
      }
    ]);
    const metadata = {
      sourceSessionId: sessionId,
      cwd,
      transcriptPath,
      hookEventName: "SessionStart",
      sessionStartSource: "resume"
    };
    const args = ["--source", "claude"];
    await recordCaptureHookFolder(env, metadata, args);
    signalCaptureHook(env, metadata, args);
    const key = {
      sourceKind: "claude-code" as const,
      externalSessionId: sessionId
    };
    expect(readSourceFolderObservation(paths, key)).toBeUndefined();
    expect(readSourceRepositoryIdentity(paths, key)).toBeUndefined();
    expect(readCurrentSourceFolderObservation(paths, key)?.normalizedPath).toBe(
      cwd
    );
    const signals = claudeWatcherSignalDirectory(env);
    const [signal] = readdirSync(signals);
    expect(
      JSON.parse(readFileSync(resolve(signals, signal!), "utf8"))
    ).toMatchObject({
      sourceSessionId: sessionId,
      transcriptPath,
      cwd,
      hookEventName: "SessionStart",
      turnBoundary: false
    });
  });

  it("keeps resumed Claude Code history without an original Folder", async () => {
    const { root, env, paths, cwd } = await setup();
    const sessionId = "resumed-session";
    const transcriptPath = forkTranscript(root, sessionId, [
      { type: "user", sessionId: "parent-session" },
      { type: "user", sessionId }
    ]);
    const metadata = {
      sourceSessionId: sessionId,
      cwd,
      transcriptPath,
      hookEventName: "SessionStart",
      sessionStartSource: "resume"
    };
    await recordCaptureHookFolder(env, metadata, ["--source", "claude"]);
    const key = {
      sourceKind: "claude-code" as const,
      externalSessionId: sessionId
    };
    expect(readSourceFolderObservation(paths, key)).toBeUndefined();
    expect(readSourceRepositoryIdentity(paths, key)).toBeUndefined();
    expect(readCurrentSourceFolderObservation(paths, key)?.normalizedPath).toBe(
      cwd
    );
  });
});
