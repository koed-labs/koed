import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KoedServerPaths } from "./paths.js";
import {
  discoverProjectMetadata,
  forgetProjectMetadata,
  getProjectMetadataForCwd,
  listProjectMetadata
} from "./project-metadata.js";

const pathsFor = (directory: string): KoedServerPaths =>
  ({
    configDir: path.join(directory, "config"),
    projectMetadataPath: path.join(directory, "config", "projects.json")
  }) as KoedServerPaths;

const execFileFor = (repo: string) =>
  ((
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    const command = args.slice(2).join(" ");
    const responses: Record<string, string> = {
      "rev-parse --show-toplevel": repo,
      "remote -v":
        "origin\thttps://token:secret@github.com/koed-labs/koed.git (fetch)\norigin\thttps://token:secret@github.com/koed-labs/koed.git (push)",
      "branch --show-current": "feature/koe-219",
      "rev-parse HEAD": "abcdef1234567890",
      "rev-parse --git-common-dir": ".git",
      "rev-parse --git-dir": ".git"
    };
    const response = responses[command];
    if (response === undefined) {
      callback(new Error(`unexpected git command: ${command}`), "");
      return;
    }
    callback(null, `${response}\n`);
  }) as never;

describe("Project metadata discovery", () => {
  it("discovers and stores privacy-conscious Project metadata", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const repo = path.join(directory, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "koed" })
    );
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const paths = pathsFor(directory);

    const discovered = await discoverProjectMetadata(
      paths,
      { cwd: path.join(repo, "packages", "api"), aiClientSource: "codex" },
      {
        execFile: execFileFor(repo),
        randomId: () => "device-salt",
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );

    expect(discovered).toMatchObject({
      ok: true,
      state: "discovered",
      project: {
        displayName: "koed",
        path: {
          projectRoot: repo,
          basename: "repo"
        },
        git: {
          branch: "feature/koe-219",
          headCommit: "abcdef1234567890",
          remoteAliases: [
            expect.objectContaining({
              display: "github.com/koed-labs/koed"
            })
          ]
        },
        packages: [{ manager: "pnpm", name: "koed" }]
      }
    });
    expect(discovered.project?.localProjectId).toMatch(/^lp_/);
    expect(discovered.project?.git?.remotes[0]?.fingerprint).toMatch(/^gr_/);
    const raw = fs.readFileSync(paths.projectMetadataPath, "utf8");
    expect(raw).toContain(repo);
    expect(raw).not.toMatch(/token|secret|password|cookie|credential/i);
    expect(listProjectMetadata(paths).projects).toHaveLength(1);
    expect(getProjectMetadataForCwd(paths, repo).project?.displayName).toBe(
      "koed"
    );
    expect(
      forgetProjectMetadata(paths, discovered.project!.localProjectId).ok
    ).toBe(true);
    expect(listProjectMetadata(paths).projects).toHaveLength(0);
  });

  it("migrates legacy source identities and unsafe remote aliases", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const paths = pathsFor(directory);
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(
      paths.projectMetadataPath,
      JSON.stringify({
        schemaVersion: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        deviceSaltId: "pms_device-salt",
        projects: [
          {
            schemaVersion: 1,
            discoveredAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
            localProjectId: "lp_1111111111111111",
            sourceProjectId: "sp_2222222222222222",
            displayName: "koed",
            path: {
              cwd: "/repo/koed",
              projectRoot: "/repo/koed",
              basename: "koed",
              localPathHash: "hmac_sha256:path"
            },
            git: {
              rootHash: "hmac_sha256:root",
              remotes: [
                {
                  name: "origin",
                  host: "gitlab.example.com",
                  owner: "platform",
                  repo: "koed",
                  display: "gitlab.example.com/platform/koed",
                  fingerprint: "gr_11111111111111111111111111111111"
                },
                {
                  name: "upstream",
                  host: "github.com",
                  namespace: "koed-labs",
                  repo: "koed",
                  display: "github.com/koed-labs/koed",
                  fingerprint: "gr_22222222222222222222222222222222"
                }
              ],
              remoteSetFingerprint: "grs_11111111111111111111111111111111",
              branch: "main",
              headCommit: "abcdef",
              isWorktree: false,
              worktreeHash: null
            },
            packages: []
          }
        ]
      })
    );

    const [project] = listProjectMetadata(paths).projects ?? [];
    expect(project).not.toHaveProperty("sourceProjectId");
    expect(project?.git?.remotes).toEqual([
      expect.objectContaining({ display: "github.com/koed-labs/koed" })
    ]);
    const migrated = JSON.parse(
      fs.readFileSync(paths.projectMetadataPath, "utf8")
    ) as Record<string, unknown>;
    expect(project?.git).toMatchObject({
      commonDirHash: null,
      remoteAliases: [
        expect.objectContaining({ display: "github.com/koed-labs/koed" })
      ]
    });
    expect(migrated.schemaVersion).toBe(3);
    expect(JSON.stringify(migrated)).not.toMatch(
      /sourceProjectId|remoteSetFingerprint|"owner"/
    );
  });

  it("retains historical portable remote aliases across discovery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const repo = path.join(directory, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const paths = pathsFor(directory);
    let remoteOutput = "origin\thttps://github.com/koed-labs/koed.git (fetch)";
    const execFile = ((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      const command = args.slice(2).join(" ");
      const responses: Record<string, string> = {
        "rev-parse --show-toplevel": repo,
        "remote -v": remoteOutput,
        "branch --show-current": "main",
        "rev-parse HEAD": "abcdef1234567890",
        "rev-parse --git-common-dir": ".git",
        "rev-parse --git-dir": ".git"
      };
      callback(null, `${responses[command] ?? ""}\n`);
    }) as never;
    const deps = { execFile, randomId: () => "device-salt" };

    const first = await discoverProjectMetadata(paths, { cwd: repo }, deps);
    remoteOutput = "origin\thttps://github.com/alice/koed.git (fetch)";
    const second = await discoverProjectMetadata(paths, { cwd: repo }, deps);

    expect(second.project?.localProjectId).toBe(first.project?.localProjectId);
    expect(second.project?.git?.remotes).toHaveLength(1);
    expect(second.project?.git?.remoteAliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ display: "github.com/koed-labs/koed" }),
        expect.objectContaining({ display: "github.com/alice/koed" })
      ])
    );
  });

  it("groups worktrees by a device-local Git common-directory signal", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const main = path.join(directory, "main");
    const worktree = path.join(directory, "worktree");
    fs.mkdirSync(main, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    const paths = pathsFor(directory);
    const execFile = ((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      const target = args[1] ?? "";
      const command = args.slice(2).join(" ");
      const responses: Record<string, string> = {
        "rev-parse --show-toplevel": target,
        "remote -v": "origin\thttps://github.com/koed-labs/koed.git (fetch)",
        "branch --show-current": "main",
        "rev-parse HEAD": "abcdef1234567890",
        "rev-parse --git-common-dir":
          target === main ? ".git" : path.join(main, ".git"),
        "rev-parse --git-dir":
          target === main
            ? ".git"
            : path.join(main, ".git", "worktrees", "worktree")
      };
      callback(null, `${responses[command] ?? ""}\n`);
    }) as never;
    const deps = { execFile, randomId: () => "device-salt" };

    const mainProject = await discoverProjectMetadata(
      paths,
      { cwd: main },
      deps
    );
    const worktreeProject = await discoverProjectMetadata(
      paths,
      { cwd: worktree },
      deps
    );

    expect(worktreeProject.project?.localProjectId).not.toBe(
      mainProject.project?.localProjectId
    );
    expect(worktreeProject.project?.git?.commonDirHash).toBe(
      mainProject.project?.git?.commonDirHash
    );
    expect(mainProject.project?.git?.isWorktree).toBe(false);
    expect(worktreeProject.project?.git?.isWorktree).toBe(true);
  });

  it("keeps local-only repositories device-local", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const repo = path.join(directory, "local-only");
    fs.mkdirSync(repo, { recursive: true });
    const paths = pathsFor(directory);
    const execFile = ((
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      const command = args.slice(2).join(" ");
      if (command === "rev-parse --show-toplevel") {
        callback(null, `${repo}\n`);
        return;
      }
      if (command === "remote -v") {
        callback(new Error("no remotes"), "");
        return;
      }
      const responses: Record<string, string> = {
        "branch --show-current": "main",
        "rev-parse HEAD": "abcdef1234567890",
        "rev-parse --git-common-dir": ".git",
        "rev-parse --git-dir": ".git"
      };
      callback(null, `${responses[command] ?? ""}\n`);
    }) as never;

    const discovered = await discoverProjectMetadata(
      paths,
      { cwd: repo },
      { execFile, randomId: () => "device-salt" }
    );

    expect(discovered.project).not.toHaveProperty("sourceProjectId");
    expect(discovered.project?.git?.remotes).toEqual([]);
    expect(discovered.project?.localProjectId).toMatch(/^lp_/);
  });

  it("does not recursively discover repositories below the supplied cwd", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-project-"));
    const parent = path.join(directory, "code");
    fs.mkdirSync(path.join(parent, "api", ".git"), { recursive: true });
    fs.mkdirSync(path.join(parent, "web", ".git"), { recursive: true });
    const paths = pathsFor(directory);
    const execFile = ((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => callback(new Error("not inside a repository"), "")) as never;

    const discovered = await discoverProjectMetadata(
      paths,
      { cwd: parent },
      { execFile, randomId: () => "device-salt" }
    );

    expect(discovered.project?.path).toMatchObject({
      cwd: parent,
      projectRoot: null,
      basename: "code"
    });
    expect(listProjectMetadata(paths).projects).toHaveLength(1);
  });
});
