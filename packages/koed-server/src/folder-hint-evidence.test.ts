import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeGitRemoteUrl } from "@koed-labs/shared";
import { ensureDeviceIdentity } from "./device-identity.js";
import { observeCaptureFolder } from "./folder-context.js";
import {
  gatherFolderHintInput,
  hintForConversation,
  hintsForConversation,
  type FolderHintConversation
} from "./folder-hint-evidence.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  discoverProjectMetadata,
  setProjectAssociationLookup,
  setProjectRepositoryAnchor
} from "./project-metadata.js";

vi.mock("node:fs/promises", { spy: true });

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

  it.each(["oversized", "invalid"])(
    "suppresses creation when the registry is %s",
    async (failure) => {
      const { root, paths, env } = await fixture();
      const directory = resolve(root, "registered");
      mkdirSync(directory);
      const observed = (await observeCaptureFolder(paths, directory, env))!;
      const registry = resolve(paths.configDir, "folder-contexts.json");
      if (failure === "oversized") truncateSync(registry, 16 * 1024 * 1024 + 1);
      else writeFileSync(registry, "{}");
      const hints = await hintsForConversation(
        paths,
        conversation({
          recordedCwd: directory,
          originDeviceId: observed.identity.originatingDeviceId,
          firstConversationAt: Date.now() + 60_000
        }),
        { environment: env, now: () => Date.now() + 120_000 }
      );
      expect(hints).not.toContainEqual(
        expect.objectContaining({ kind: "create" })
      );
    }
  );

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

    it("scores an advisory creation hint without registering a Folder", async () => {
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

    const upstream = "https://example.test/acme/main.git";
    const custom = "https://example.test/acme/custom.git";
    const addRemote = (cwd: string, name: string, url: string) =>
      execFileSync("git", ["remote", "add", name, url], { cwd });

    const anchorFixture = async () => {
      const { root, paths, env } = await fixture();
      const directory = resolve(root, "fork");
      gitRepo(directory);
      addRemote(directory, "upstream", upstream);
      addRemote(directory, "custom", custom);
      const { firstConversationAt, now } = timing();
      const anchor = async (
        lookupAssociatedSelection?: NonNullable<
          Parameters<typeof hintsForConversation>[2]
        >["lookupAssociatedSelection"],
        cwd = directory
      ) => {
        const hints = await hintsForConversation(
          paths,
          conversation({
            recordedCwd: cwd,
            capturedOnThisDevice: true,
            firstConversationAt
          }),
          { environment: env, now, lookupAssociatedSelection }
        );
        return hints?.find(
          (hint) => hint.tier !== "none" && hint.kind === "repository"
        );
      };
      const discover = async () => {
        const { project } = await discoverProjectMetadata(paths, {
          cwd: directory
        });
        return {
          localProjectId: project!.localProjectId,
          expectedCheckoutId: project!.repository!.checkoutId!
        };
      };
      return { directory, paths, anchor, discover };
    };

    it("infers upstream rather than the fork's origin without creating checkout metadata", async () => {
      const { paths, anchor } = await anchorFixture();
      expect(await anchor()).toMatchObject({
        repositoryKey: normalizeGitRemoteUrl(upstream).fingerprint
      });
      expect(() => readFileSync(paths.projectMetadataPath)).toThrow(/ENOENT/);
    });

    it("does not infer a Git Anchor from conflicting fetch and push URLs on upstream", async () => {
      const { directory, anchor } = await anchorFixture();
      execFileSync("git", ["remote", "set-url", "--push", "upstream", custom], {
        cwd: directory
      });
      expect(await anchor()).toBeUndefined();
    });

    it("does not infer a Git Anchor when Git's remote listing hides a second fetch URL", async () => {
      const { directory, paths, anchor } = await anchorFixture();
      execFileSync("git", ["remote", "set-url", "--add", "upstream", custom], {
        cwd: directory
      });
      execFileSync(
        "git",
        ["remote", "set-url", "--push", "upstream", upstream],
        {
          cwd: directory
        }
      );
      expect(await anchor()).toBeUndefined();
      const { project } = await discoverProjectMetadata(paths, {
        cwd: directory
      });
      expect(project?.repository).toMatchObject({
        kind: "unresolved",
        reason: "selection_conflict",
        selectedRemote: "upstream",
        key: null
      });
    });

    it("uses the current checkout's explicit selection from a subdirectory and never falls back if it is missing", async () => {
      const { directory, paths, anchor, discover } = await anchorFixture();
      await setProjectRepositoryAnchor(paths, {
        ...(await discover()),
        remoteName: "custom"
      });
      const snapshot = readFileSync(paths.projectMetadataPath, "utf8");
      const nested = resolve(directory, "nested");
      mkdirSync(nested);
      expect(await anchor(undefined, nested)).toMatchObject({
        repositoryKey: normalizeGitRemoteUrl(custom).fingerprint
      });
      execFileSync("git", ["remote", "remove", "custom"], { cwd: directory });
      expect(await anchor(undefined, nested)).toBeUndefined();
      expect(readFileSync(paths.projectMetadataPath, "utf8")).toBe(snapshot);
    });

    it("honors enabled associated selections and does not guess when lookup is unavailable or conflicted", async () => {
      const { paths, anchor, discover } = await anchorFixture();
      await setProjectAssociationLookup(paths, {
        ...(await discover()),
        enabled: true
      });
      expect(
        await anchor(async () => ({
          associationId: "accepted",
          selection: {
            state: "selected",
            anchorFingerprint: normalizeGitRemoteUrl(custom).fingerprint
          }
        }))
      ).toMatchObject({
        repositoryKey: normalizeGitRemoteUrl(custom).fingerprint
      });
      expect(
        await anchor(async () => ({
          associationId: "accepted",
          selection: { state: "conflict" }
        }))
      ).toBeUndefined();
      expect(await anchor()).toBeUndefined();
      expect(await anchor(async () => undefined)).toMatchObject({
        repositoryKey: normalizeGitRemoteUrl(upstream).fingerprint
      });
    });

    it("observes remotes after an associated selection lookup", async () => {
      const { directory, paths, anchor, discover } = await anchorFixture();
      await setProjectAssociationLookup(paths, {
        ...(await discover()),
        enabled: true
      });
      expect(
        await anchor(async () => {
          execFileSync("git", ["remote", "remove", "custom"], {
            cwd: directory
          });
          return {
            associationId: "accepted",
            selection: {
              state: "selected",
              anchorFingerprint: normalizeGitRemoteUrl(custom).fingerprint
            }
          };
        })
      ).toBeUndefined();
    });

    it.each(["primary", "linked"])(
      "keeps a %s checkout advisory when its Git directory is newer than the source",
      async (kind) => {
        const { root, paths, env } = await fixture();
        const remote = "https://github.com/acme/history.git";
        const main = resolve(root, "main");
        const directory = resolve(root, "reviewed");
        mkdirSync(main);
        mkdirSync(directory);
        const git = (cwd: string, ...args: string[]) =>
          execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
        if (kind === "linked") {
          git(main, "init", "-q");
          git(main, "remote", "add", "origin", remote);
          git(
            main,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "commit",
            "-qm",
            "initial",
            "--allow-empty"
          );
        }
        const start = Date.now() + 2;
        await setTimeout(25);
        if (kind === "linked") {
          git(main, "worktree", "add", "--quiet", "--detach", directory);
          expect(statSync(resolve(main, ".git")).birthtimeMs).toBeLessThan(
            start
          );
        } else {
          git(directory, "init", "-q");
          git(directory, "remote", "add", "origin", remote);
        }
        const gitDir = git(directory, "rev-parse", "--absolute-git-dir");
        const birth = statSync(gitDir).birthtimeMs;
        expect(statSync(directory).birthtimeMs).toBeLessThan(start);
        expect(birth).toBeGreaterThan(start);
        const find = async (firstConversationAt: number) =>
          (
            await hintsForConversation(
              paths,
              conversation({
                recordedCwd: directory,
                firstConversationAt,
                allowUnknownRepositoryCandidate: true
              }),
              { environment: env, now: () => birth + 10_000 }
            )
          )?.find((hint) => hint.tier !== "none" && hint.kind === "repository");
        for (const [time, outcome] of [
          [start, "does-not-agree"],
          [birth, "does-not-agree"],
          [birth + 1, "agrees"]
        ] as const) {
          expect(await find(time)).toMatchObject({
            directory,
            repositoryKey: normalizeGitRemoteUrl(remote).fingerprint,
            reasons: expect.arrayContaining([
              { code: "git-directory-birthtime", outcome }
            ]) as unknown
          });
        }
      }
    );

    it("provides a manual-only incarnation when Git directory birthtime is unavailable", async () => {
      const { root, paths, env } = await fixture();
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/acme/history.git"],
        { cwd: root }
      );
      const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: root,
        encoding: "utf8"
      }).trim();
      const { stat: actualStat } =
        await vi.importActual<typeof fsPromises>("node:fs/promises");
      const stat = vi.mocked(fsPromises.stat);
      stat.mockImplementation(async (path, options) => {
        const info = await actualStat(path, options);
        if (path === gitDir && info && "birthtimeNs" in info)
          info.birthtimeNs = 0n;
        return info;
      });
      try {
        const start = Date.now() + 1_000;
        const result = await hintsForConversation(
          paths,
          conversation({
            recordedCwd: root,
            firstConversationAt: start,
            allowUnknownRepositoryCandidate: true
          }),
          { environment: env, now: () => start + 1_000 }
        );
        const hint = result?.find(
          (hint) => hint.tier !== "none" && hint.kind === "repository"
        );
        expect(typeof hint?.manualGitCheckoutIncarnation).toBe("string");
        expect(hint?.reasons).toContainEqual({
          code: "git-directory-birthtime",
          outcome: "unavailable"
        });
        expect(hint).not.toHaveProperty("gitCheckoutIncarnation");
      } finally {
        stat.mockRestore();
      }
    });

    it("offers an eligible unknown-device repository only for strict pre-start birthtime", async () => {
      const { root, paths, env } = await fixture();
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/acme/history.git"],
        { cwd: root }
      );
      const birth = statSync(root).birthtimeMs;
      const find = async (
        firstConversationAt: number | null,
        overrides: Partial<FolderHintConversation> = {}
      ) =>
        (
          await hintsForConversation(
            paths,
            conversation({
              recordedCwd: root,
              firstConversationAt,
              allowUnknownRepositoryCandidate: true,
              ...overrides
            }),
            { environment: env, now: () => birth + 10_000 }
          )
        )?.filter((hint) => hint.tier !== "none");
      expect(await find(birth + 1)).toEqual([
        expect.objectContaining({
          kind: "repository",
          directory: root,
          repositoryKey: normalizeGitRemoteUrl(
            "https://github.com/acme/history.git"
          ).fingerprint,
          reasons: expect.arrayContaining([
            { code: "origin-device", outcome: "unavailable" },
            { code: "directory-birthtime", outcome: "agrees" }
          ]) as unknown
        })
      ]);
      for (const start of [birth, birth - 1, null, birth + 10_001])
        expect(await find(start)).toEqual([]);
      expect(
        await find(birth + 1, { allowUnknownRepositoryCandidate: false })
      ).toEqual([]);
      expect(
        await find(birth + 1, { originDeviceId: "foreign-device" })
      ).toEqual([]);
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
      expect(
        hints?.find(
          (hint) => hint.tier !== "none" && hint.kind === "repository"
        )
      ).toMatchObject({
        tier: "medium",
        repositoryKey: key,
        directory
      });
      // A Conversation that already has an anchor gets none.
      const known = await hintsForConversation(paths, subject(true), {
        environment: env,
        now
      });
      expect(
        known?.some(
          (hint) => hint.tier !== "none" && hint.kind === "repository"
        )
      ).toBe(false);
    });
  });
});
