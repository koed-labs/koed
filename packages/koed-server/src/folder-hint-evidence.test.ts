import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeGitRemoteUrl } from "@koed-labs/shared";
import { ensureDeviceIdentity } from "./device-identity.js";
import { observeCaptureFolder } from "./folder-context.js";
import {
  createHintedFolder,
  gatherFolderHintInput,
  hintForConversation,
  hintsForConversation,
  type FolderHintConversation
} from "./folder-hint-evidence.js";
import { resolveKoedServerPaths } from "./paths.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const temporary: string[] = [];
const fixture = async () => {
  const parent = resolve(
    import.meta.dirname,
    "../../../scratch/folder-hint/local"
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "evidence-"));
  temporary.push(root);
  const env = {
    NODE_ENV: "test",
    KOED_HOME: resolve(root, "profile"),
    KOED_REPO_ROOT: root
  };
  const paths = resolveKoedServerPaths(env);
  await ensureDeviceIdentity(paths, { environment: env });
  return { root, env, paths };
};
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const unresolved = (reason: "missing" | "historical_unresolved") => ({
  revision: 1,
  original: { state: "unresolved" as const, reason },
  correction: { state: "original" as const }
});
const conversation = (
  overrides: Partial<FolderHintConversation> = {}
): FolderHintConversation => ({
  ownerUserId: OWNER,
  folderAssignment: unresolved("missing"),
  recordedCwd: null,
  originDeviceId: null,
  firstConversationAt: Date.now(),
  recordedRemoteFingerprint: null,
  recordedMetadataState: "resolved",
  ...overrides
});

describe("Folder hint evidence", () => {
  it("rejects a recorded directory that is gone, and never creates a registry", async () => {
    const { root, paths, env } = await fixture();
    const input = await gatherFolderHintInput(
      paths,
      conversation({ recordedCwd: resolve(root, "gone") }),
      { environment: env }
    );
    expect(input?.directoryStat).toBeNull();
    expect(input?.registry).toEqual({ state: "missing" });
    const hint = await hintForConversation(
      paths,
      conversation({ recordedCwd: resolve(root, "gone") }),
      { environment: env }
    );
    expect(hint?.tier).toBe("none");
  });

  it("does not register an unregistered directory while scoring it", async () => {
    const { root, paths, env } = await fixture();
    const directory = resolve(root, "unregistered");
    mkdirSync(directory);
    const input = await gatherFolderHintInput(
      paths,
      conversation({ recordedCwd: directory }),
      { environment: env }
    );
    expect(input?.registry).toEqual({ state: "missing" });
    expect(input?.directoryStat?.isDirectory).toBe(true);
    // Read-only: a later live observation must still be the first registration.
    const observed = await observeCaptureFolder(paths, directory, env);
    expect(observed?.identity.folderId).toBeTruthy();
  });

  it("matches a live registration and carries its exact Folder identity", async () => {
    const { root, paths, env } = await fixture();
    const directory = resolve(root, "registered");
    mkdirSync(directory);
    const observed = (await observeCaptureFolder(paths, directory, env))!;
    const input = await gatherFolderHintInput(
      paths,
      conversation({
        recordedCwd: directory,
        originDeviceId: observed.identity.originatingDeviceId,
        // Older than the directory's creation makes the birthtime veto apply.
        firstConversationAt: Date.now() + 60_000
      }),
      { environment: env }
    );
    expect(input?.currentDeviceId).toBe(observed.identity.originatingDeviceId);
    expect(input?.registry).toMatchObject({
      state: "matched",
      normalizedPath: observed.normalizedPath,
      folder: {
        ownerUserId: OWNER,
        folderId: observed.identity.folderId,
        directoryIncarnationId: observed.identity.directoryIncarnationId
      }
    });
  });

  it("vetoes a directory created after the Conversation began", async () => {
    const { root, paths, env } = await fixture();
    const directory = resolve(root, "replaced");
    mkdirSync(directory);
    await observeCaptureFolder(paths, directory, env);
    const hint = await hintForConversation(
      paths,
      conversation({
        recordedCwd: directory,
        firstConversationAt: Date.now() - 365 * 24 * 60 * 60 * 1000
      }),
      { environment: env }
    );
    expect(hint?.tier).toBe("none");
    expect(
      hint?.reasons.find((r) => r.code === "directory-birthtime")?.outcome
    ).toMatch(/rejects|unavailable/);
  });

  it("reads the current Git remote fingerprint and counts only contained files", async () => {
    const { root, paths, env } = await fixture();
    const directory = resolve(root, "repo");
    mkdirSync(directory);
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.test/acme/koed.git"],
      { cwd: directory }
    );
    const fingerprint = normalizeGitRemoteUrl(
      "https://example.test/acme/koed.git"
    ).fingerprint;
    writeFileSync(resolve(directory, "a.txt"), "x");
    const outside = resolve(root, "outside.txt");
    writeFileSync(outside, "x");
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    utimesSync(directory, old, old);
    const inside = await gatherFolderHintInput(
      paths,
      conversation({
        recordedCwd: directory,
        recordedRemoteFingerprint: fingerprint,
        referencedPaths: [resolve(directory, "a.txt")]
      }),
      { environment: env }
    );
    expect(inside?.currentRemoteFingerprint).toBe(fingerprint);
    expect(inside?.hasContainedTranscriptFile).toBe(true);
    const escaped = await gatherFolderHintInput(
      paths,
      conversation({
        recordedCwd: directory,
        referencedPaths: [outside, resolve(directory, "..", "outside.txt")]
      }),
      { environment: env }
    );
    expect(escaped?.hasContainedTranscriptFile).toBe(false);
  });

  it("returns nothing when this device has no ready identity", async () => {
    const parent = resolve(
      import.meta.dirname,
      "../../../scratch/folder-hint/local"
    );
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(resolve(parent, "noidentity-"));
    temporary.push(root);
    const env = {
      NODE_ENV: "test",
      KOED_HOME: resolve(root, "profile"),
      KOED_REPO_ROOT: root
    };
    const paths = resolveKoedServerPaths(env);
    expect(
      await gatherFolderHintInput(paths, conversation(), { environment: env })
    ).toBeNull();
  });

  describe("candidates beyond a registered Folder", () => {
    const REMOTE = "https://example.test/acme/koed.git";
    const fingerprint = normalizeGitRemoteUrl(REMOTE).fingerprint;
    const day = 24 * 60 * 60 * 1000;
    // The directory is created moments ago, so evaluate later and place the
    // Conversation between its creation and the evaluation.
    const timing = () => ({
      firstConversationAt: Date.now() + 60_000,
      now: () => Date.now() + day
    });
    const gitRepo = (directory: string) => {
      mkdirSync(directory, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: directory });
      execFileSync("git", ["remote", "add", "origin", REMOTE], {
        cwd: directory
      });
    };

    it("offers to create a Folder for an unregistered directory, then registers it only on confirmation", async () => {
      const { root, paths, env } = await fixture();
      const directory = resolve(root, "history");
      gitRepo(directory);
      const { firstConversationAt, now } = timing();
      const subject = conversation({
        folderAssignment: unresolved("historical_unresolved"),
        recordedCwd: directory,
        capturedOnThisDevice: true,
        recordedRemoteFingerprint: fingerprint,
        firstConversationAt
      });
      const hint = await hintForConversation(paths, subject, {
        environment: env,
        now
      });
      expect(hint).toMatchObject({
        tier: "strong",
        kind: "create",
        directory
      });
      const scored = await gatherFolderHintInput(paths, subject, {
        environment: env,
        now
      });
      expect(scored?.registry).toEqual({ state: "missing" });

      const observation = await createHintedFolder(paths, subject, {
        environment: env,
        now
      });
      expect(observation?.normalizedPath).toBe(directory);
      const after = await gatherFolderHintInput(paths, subject, {
        environment: env,
        now
      });
      expect(after?.registry).toMatchObject({
        state: "matched",
        folder: { folderId: observation?.identity.folderId }
      });
    });

    it("refuses to create a Folder when the evidence no longer qualifies", async () => {
      const { root, paths, env } = await fixture();
      const directory = resolve(root, "later");
      gitRepo(directory);
      const subject = conversation({
        recordedCwd: directory,
        capturedOnThisDevice: true,
        recordedRemoteFingerprint: fingerprint,
        // The directory was created after this Conversation began.
        firstConversationAt: Date.now() - 365 * day
      });
      expect(
        await createHintedFolder(paths, subject, { environment: env })
      ).toBeNull();
      const replica = conversation({
        recordedCwd: directory,
        recordedRemoteFingerprint: fingerprint,
        ...timing()
      });
      expect(
        await createHintedFolder(paths, replica, {
          environment: env,
          now: timing().now
        })
      ).toBeNull();
      expect(
        (await gatherFolderHintInput(paths, subject, { environment: env }))
          ?.registry
      ).toEqual({ state: "missing" });
    });

    it("does not infer a parent for a standalone checkout at the Claude worktree path", async () => {
      const { root, paths, env } = await fixture();
      const main = resolve(root, "main");
      const cwd = resolve(main, ".claude/worktrees/standalone");
      gitRepo(main);
      gitRepo(cwd);
      await observeCaptureFolder(paths, main, env);
      const { firstConversationAt, now } = timing();
      const input = await gatherFolderHintInput(
        paths,
        conversation({
          recordedCwd: cwd,
          capturedOnThisDevice: true,
          recordedRemoteFingerprint: fingerprint,
          firstConversationAt
        }),
        { environment: env, now }
      );
      expect(input?.worktree).toBeUndefined();
    });

    it("skips worktree discovery for an ineligible Claude Conversation", async () => {
      const { root, paths, env } = await fixture();
      const main = resolve(root, "main");
      gitRepo(main);
      await observeCaptureFolder(paths, main, env);
      const { firstConversationAt, now } = timing();
      const lookupClientWorktree = vi.fn(async () => ({
        state: "worktree" as const,
        originPath: main
      }));
      const input = await gatherFolderHintInput(
        paths,
        conversation({
          sourceRuntime: "claude-code",
          externalSessionId: "cli-1",
          recordedCwd: resolve(main, ".claude/worktrees/deleted"),
          recordedRemoteFingerprint: fingerprint,
          firstConversationAt
        }),
        { environment: env, now, lookupClientWorktree }
      );
      expect(input?.worktree).toBeUndefined();
      expect(lookupClientWorktree).not.toHaveBeenCalled();
    });

    it("links a deleted Claude Code worktree to its registered main checkout by path", async () => {
      const { root, paths, env } = await fixture();
      const main = resolve(root, "main");
      gitRepo(main);
      const observed = (await observeCaptureFolder(paths, main, env))!;
      const { firstConversationAt, now } = timing();
      const hint = await hintForConversation(
        paths,
        conversation({
          recordedCwd: resolve(main, ".claude/worktrees/task-1"),
          capturedOnThisDevice: true,
          recordedRemoteFingerprint: fingerprint,
          firstConversationAt
        }),
        { environment: env, now }
      );
      expect(hint).toMatchObject({
        tier: "medium",
        kind: "worktree-parent",
        directory: main,
        folder: { folderId: observed.identity.folderId }
      });
      expect(hint?.reasons).not.toContainEqual({
        code: "worktree-link-git",
        outcome: "agrees"
      });
      expect(
        await hintForConversation(
          paths,
          conversation({
            recordedCwd: resolve(main, ".claude/worktrees/task-1"),
            capturedOnThisDevice: true,
            firstConversationAt
          }),
          { environment: env, now }
        )
      ).toMatchObject({ tier: "none" });
      // Accepting it returns the main checkout's existing Folder, never a new one.
      const subject = conversation({
        recordedCwd: resolve(main, ".claude/worktrees/task-1"),
        capturedOnThisDevice: true,
        recordedRemoteFingerprint: fingerprint,
        firstConversationAt
      });
      const accepted = await createHintedFolder(paths, subject, {
        environment: env,
        now,
        kind: "worktree-parent"
      });
      expect(accepted?.identity.folderId).toBe(observed.identity.folderId);
      // A kind the evidence does not support registers nothing.
      expect(
        await createHintedFolder(paths, subject, {
          environment: env,
          now,
          kind: "create"
        })
      ).toBeNull();
    });

    it("links an existing linked worktree to its main checkout through Git", async () => {
      const { root, paths, env } = await fixture();
      const main = resolve(root, "main");
      gitRepo(main);
      execFileSync(
        "git",
        [
          "-c",
          "user.email=t@example.test",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "x"
        ],
        { cwd: main }
      );
      const worktree = resolve(root, "feature-tree");
      execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: main });
      const observed = (await observeCaptureFolder(paths, main, env))!;
      const { firstConversationAt, now } = timing();
      const hint = await hintForConversation(
        paths,
        conversation({
          recordedCwd: worktree,
          capturedOnThisDevice: true,
          firstConversationAt
        }),
        { environment: env, now }
      );
      expect(hint).toMatchObject({
        kind: "worktree-parent",
        folder: { folderId: observed.identity.folderId }
      });
    });

    it("trusts the client's recorded origin for a worktree outside any known layout, and its denial of one", async () => {
      const { root, paths, env } = await fixture();
      const main = resolve(root, "main");
      gitRepo(main);
      const observed = (await observeCaptureFolder(paths, main, env))!;
      const homeDir = resolve(root, "home");
      const sessions = resolve(
        homeDir,
        "Library/Application Support/Claude/claude-code-sessions/a"
      );
      mkdirSync(sessions, { recursive: true });
      const cwd = resolve(root, "elsewhere/task-9");
      const record = (originCwd: string) =>
        writeFileSync(
          resolve(sessions, "local_9.json"),
          JSON.stringify({
            cliSessionId: "cli-9",
            cwd,
            worktreePath: cwd,
            originCwd
          })
        );
      const { firstConversationAt, now } = timing();
      const subject = conversation({
        recordedCwd: cwd,
        sourceRuntime: "claude-code",
        externalSessionId: "cli-9",
        capturedOnThisDevice: true,
        recordedRemoteFingerprint: fingerprint,
        firstConversationAt
      });
      const options = { environment: env, now, homeDir };
      // Without a client record nothing links this directory to the main checkout.
      expect(await hintForConversation(paths, subject, options)).toMatchObject({
        tier: "none"
      });
      record(main);
      const hint = await hintForConversation(paths, subject, options);
      expect(hint).toMatchObject({
        tier: "medium",
        kind: "worktree-parent",
        folder: { folderId: observed.identity.folderId }
      });
      expect(hint?.reasons).toContainEqual({
        code: "worktree-link-recorded",
        outcome: "agrees"
      });
      // A client that says the session ran in its own directory overrides the path guess.
      const guessed = resolve(main, ".claude/worktrees/task-1");
      writeFileSync(
        resolve(sessions, "local_9.json"),
        JSON.stringify({
          cliSessionId: "cli-9",
          cwd: guessed,
          originCwd: guessed
        })
      );
      const denied = await hintForConversation(
        paths,
        { ...subject, recordedCwd: guessed },
        options
      );
      expect(denied?.tier).not.toBe("medium");
    });

    it("suggests the Git Anchor of an unregistered directory's remote, whatever protocol the remote uses", async () => {
      const { root, paths, env } = await fixture();
      const directory = resolve(root, "lyons");
      mkdirSync(directory, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: directory });
      // The remote is written as ssh; a Project anchored over https shares its key.
      execFileSync(
        "git",
        ["remote", "add", "origin", "git@github.com:acme/lyons-mouth.git"],
        { cwd: directory }
      );
      const key = normalizeGitRemoteUrl(
        "https://github.com/acme/lyons-mouth"
      ).fingerprint;
      const { firstConversationAt, now } = timing();
      const subject = (gitAnchorKnown: boolean) =>
        conversation({
          recordedCwd: directory,
          capturedOnThisDevice: true,
          firstConversationAt,
          gitAnchorKnown
        });
      const hints = await hintsForConversation(paths, subject(false), {
        environment: env,
        now
      });
      expect(hints?.find((hint) => hint.kind === "repository")).toMatchObject({
        tier: "medium",
        repositoryKey: key,
        directory
      });
      // A Conversation that already has an anchor gets none.
      const known = await hintsForConversation(paths, subject(true), {
        environment: env,
        now
      });
      expect(known?.some((hint) => hint.kind === "repository")).toBe(false);
    });
  });
});
