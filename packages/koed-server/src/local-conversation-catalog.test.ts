import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listLocalConversationSources } from "./local-conversation-catalog.js";

const temporaryDirectories: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-local-catalog-"));
  temporaryDirectories.push(root);
  return root;
};

const writeProjectRegistry = async (
  koedHome: string,
  projects: Array<{
    localProjectId: string;
    displayName: string;
    cwd: string;
    projectRoot?: string | null;
  }>
): Promise<void> => {
  const config = path.join(koedHome, "config");
  await mkdir(config, { recursive: true });
  await writeFile(
    path.join(config, "projects.json"),
    JSON.stringify({
      schemaVersion: 3,
      projects: projects.map((project) => ({
        schemaVersion: 1,
        localProjectId: project.localProjectId,
        displayName: project.displayName,
        path: {
          cwd: project.cwd,
          projectRoot: project.projectRoot ?? null
        }
      }))
    })
  );
};

const createCodexStateDatabase = async (
  filename: string,
  rows: Array<{ id: string; name?: string | null; title?: string | null }>,
  columns: Array<"name" | "title"> = ["name", "title"]
): Promise<boolean> => {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(filename);
    try {
      database.exec(
        `CREATE TABLE threads (id TEXT PRIMARY KEY${columns
          .map((column) => `, "${column}" TEXT`)
          .join("")})`
      );
      const placeholders = ["?", ...columns.map(() => "?")].join(", ");
      const insert = database.prepare(
        `INSERT INTO threads VALUES (${placeholders})`
      );
      database.exec("BEGIN");
      for (const row of rows)
        insert.run(row.id, ...columns.map((column) => row[column] ?? null));
      database.exec("COMMIT");
      return true;
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_BUILTIN_MODULE")
      return false;
    throw error;
  }
};

const writeCodexSession = async (
  root: string,
  id: string,
  cwd = `/work/${id}`
): Promise<string> => {
  const filename = path.join(root, `${id}.jsonl`);
  await writeFile(
    filename,
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`
  );
  return filename;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("listLocalConversationSources", () => {
  it("prefers Codex thread names, then thread titles, over transcript titles", async (context) => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const hasSqlite = await createCodexStateDatabase(
      path.join(codexHome, "state_5.sqlite"),
      [
        { id: "thread-name", name: "Actual Codex name", title: "Old title" },
        { id: "thread-title", name: "  ", title: "Title column" }
      ]
    );
    if (!hasSqlite) return context.skip();
    await Promise.all([
      writeFile(
        path.join(root, "name.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-name", title: "Transcript name" } })}\n`
      ),
      writeFile(
        path.join(root, "title.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-title", title: "Transcript title" } })}\n`
      )
    ]);

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });
    const byId = new Map(page.items.map((item) => [item.sourceId, item]));

    expect(byId.get("codex:thread-name")?.title).toBe("Actual Codex name");
    expect(byId.get("codex:thread-title")?.title).toBe("Title column");
  });

  it("uses transcript title fallback when the optional Codex database schema has no title column", async (context) => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const hasSqlite = await createCodexStateDatabase(
      path.join(codexHome, "state_5.sqlite"),
      [{ id: "without-name", title: "  " }],
      ["title"]
    );
    if (!hasSqlite) return context.skip();
    await writeFile(
      path.join(root, "fallback.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "without-name", title: "Transcript fallback" } })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items[0]?.title).toBe("Transcript fallback");
  });

  it("bounds Codex thread-title rows and keeps transcript fallback for older threads", async (context) => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const threadRows = Array.from({ length: 20_001 }, (_, index) => ({
      id: `thread-${index}`,
      name: `Thread ${index}`,
      title: null
    }));
    const hasSqlite = await createCodexStateDatabase(
      path.join(codexHome, "state_5.sqlite"),
      threadRows
    );
    if (!hasSqlite) return context.skip();
    await writeFile(
      path.join(root, "older-thread.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-0", title: "Transcript fallback" } })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items[0]?.title).toBe("Transcript fallback");
  });

  it("normalizes an oversized Codex database title after bounded selection", async (context) => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const hasSqlite = await createCodexStateDatabase(
      path.join(codexHome, "state_5.sqlite"),
      [{ id: "large-title", name: "A".repeat(20_000) }]
    );
    if (!hasSqlite) return context.skip();
    await writeFile(
      path.join(root, "large-title.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "large-title", title: "Transcript title" } })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items[0]?.title).toBe(`${"A".repeat(99)}…`);
  });

  it("returns provider-qualified, path-free sources from all supported local roots", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const claudeHome = path.join(home, "claude-home");
    const piHome = path.join(home, "pi-home");
    const codexRoot = path.join(codexHome, "sessions", "2026", "09", "25");
    const claudeRoot = path.join(claudeHome, "projects", "private-project");
    const piRoot = path.join(piHome, "sessions");
    await Promise.all([
      mkdir(codexRoot, { recursive: true }),
      mkdir(claudeRoot, { recursive: true }),
      mkdir(piRoot, { recursive: true })
    ]);
    await writeFile(
      path.join(codexRoot, "rollout-1.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/Users/alice/work/app", title: "Catalog title", boundedField: "x".repeat(5_000) } })}\n{"type":"event_msg","payload":{"message":"private text"}}\n`
    );
    await writeFile(
      path.join(claudeRoot, "123e4567-e89b-42d3-a456-426614174000.jsonl"),
      `${JSON.stringify({ sessionId: "123e4567-e89b-42d3-a456-426614174000", cwd: "/Users/alice/work/claude-app", message: { content: "private Claude text" } })}\n`
    );
    await writeFile(
      path.join(piRoot, "pi-1.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "pi-1", cwd: "/Users/alice/work/tool" })}\n{"type":"message","content":"private text"}\n`
    );

    const page = await listLocalConversationSources({
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
        PI_CODING_AGENT_DIR: piHome
      }
    });

    expect(page.items.map((item) => item.provider).sort()).toEqual([
      "claude-code",
      "codex",
      "pi"
    ]);
    expect(page.items.find((item) => item.provider === "codex")).toMatchObject({
      sourceId: "codex:codex-1",
      title: "Catalog title",
      projectName: "app"
    });
    expect(page.items.find((item) => item.provider === "pi")).toMatchObject({
      sourceId: "pi:pi-1",
      projectName: "tool"
    });
    expect(
      page.items.find((item) => item.provider === "claude-code")
    ).toMatchObject({
      sourceId: "claude-code:123e4567-e89b-42d3-a456-426614174000",
      projectName: "claude-app"
    });
    expect(JSON.stringify(page)).not.toContain(home);
    expect(JSON.stringify(page)).not.toContain("private text");
    expect(JSON.stringify(page)).not.toContain("private Claude text");
    expect(page.providers).toMatchObject({
      codex: { status: "available" },
      "claude-code": { status: "available" },
      pi: { status: "available" }
    });
  });

  it("keeps Claude sessions without a verified cwd standalone and shares cwd identity across providers", async () => {
    const home = await makeRoot();
    const claudeHome = path.join(home, "claude-home");
    const claudeRoot = path.join(
      claudeHome,
      "projects",
      "private-storage-token"
    );
    const codexRoot = path.join(home, "codex", "sessions");
    const piRoot = path.join(home, "pi", "sessions");
    const sharedCwd = path.join(home, "work", "shared-project");
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(codexRoot, { recursive: true }),
      mkdir(piRoot, { recursive: true })
    ]);
    const standaloneId = "123e4567-e89b-42d3-a456-426614174001";
    const sharedId = "123e4567-e89b-42d3-a456-426614174002";
    await Promise.all([
      writeFile(
        path.join(claudeRoot, `${standaloneId}.jsonl`),
        `${JSON.stringify({ sessionId: standaloneId, message: "private transcript" })}\n`
      ),
      writeFile(
        path.join(claudeRoot, `${sharedId}.jsonl`),
        `${JSON.stringify({ sessionId: sharedId, cwd: sharedCwd })}\n`
      ),
      writeFile(
        path.join(codexRoot, "rollout.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "shared-codex", cwd: sharedCwd } })}\n`
      ),
      writeFile(
        path.join(piRoot, "session.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: "shared-pi", cwd: sharedCwd })}\n`
      )
    ]);

    const page = await listLocalConversationSources({
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: claudeHome,
        CODEX_HOME: path.join(home, "codex"),
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });
    const bySourceId = new Map(page.items.map((item) => [item.sourceId, item]));
    const standalone = bySourceId.get(`claude-code:${standaloneId}`);
    const claude = bySourceId.get(`claude-code:${sharedId}`);
    const codex = bySourceId.get("codex:shared-codex");
    const pi = bySourceId.get("pi:shared-pi");

    expect(standalone).toBeDefined();
    expect(standalone).not.toHaveProperty("projectId");
    expect(standalone).not.toHaveProperty("projectName");
    expect(claude?.projectId).toMatch(/^local-project:/);
    expect(claude?.projectId).toBe(codex?.projectId);
    expect(claude?.projectId).toBe(pi?.projectId);
    expect(claude).toMatchObject({ projectName: "shared-project" });
    expect(JSON.stringify(page)).not.toContain(home);
    expect(JSON.stringify(page)).not.toContain("private transcript");
  });

  it("uses the registered project identity for an exact source cwd match", async () => {
    const home = await makeRoot();
    const koedHome = path.join(home, "koed");
    const sourceCwd = path.join(home, "work", "checkout");
    const piRoot = path.join(home, "pi", "sessions");
    await mkdir(piRoot, { recursive: true });
    await writeProjectRegistry(koedHome, [
      {
        localProjectId: "lp_registered_checkout",
        displayName: "Product workspace",
        cwd: path.join(home, "work", "other-cwd"),
        projectRoot: sourceCwd
      }
    ]);
    await writeFile(
      path.join(piRoot, "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "registered", cwd: sourceCwd })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "pi",
      env: {
        ...process.env,
        HOME: home,
        KOED_HOME: koedHome,
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });

    expect(page.items[0]).toMatchObject({
      projectId: "lp_registered_checkout",
      projectName: "Product workspace"
    });
    expect(JSON.stringify(page)).not.toContain(sourceCwd);
  });

  it("does not merge distinct same-name folders by display name", async () => {
    const home = await makeRoot();
    const koedHome = path.join(home, "koed");
    const registeredCwd = path.join(home, "first", "app");
    const otherCwd = path.join(home, "second", "app");
    const piRoot = path.join(home, "pi", "sessions");
    await mkdir(piRoot, { recursive: true });
    await writeProjectRegistry(koedHome, [
      {
        localProjectId: "lp_first_app",
        displayName: "app",
        cwd: registeredCwd
      }
    ]);
    await writeFile(
      path.join(piRoot, "registered.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "first", cwd: registeredCwd })}\n`
    );
    await writeFile(
      path.join(piRoot, "other.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "second", cwd: otherCwd })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "pi",
      env: {
        ...process.env,
        HOME: home,
        KOED_HOME: koedHome,
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });
    const byId = new Map(page.items.map((item) => [item.sourceId, item]));

    expect(byId.get("pi:first")).toMatchObject({
      projectId: "lp_first_app",
      projectName: "app"
    });
    expect(byId.get("pi:second")?.projectId).toMatch(/^local-project:/);
    expect(byId.get("pi:second")?.projectId).not.toBe("lp_first_app");
    expect(byId.get("pi:second")).toMatchObject({ projectName: "app" });
    expect(JSON.stringify(page)).not.toContain(home);
  });

  it("keeps provider-specific identity for a source with no registered path match", async () => {
    const home = await makeRoot();
    const koedHome = path.join(home, "koed");
    const sourceCwd = path.join(home, "unregistered", "tool");
    const piRoot = path.join(home, "pi", "sessions");
    await mkdir(piRoot, { recursive: true });
    await writeProjectRegistry(koedHome, [
      {
        localProjectId: "lp_other_project",
        displayName: "Another project",
        cwd: path.join(home, "registered", "project")
      }
    ]);
    await writeFile(
      path.join(piRoot, "unmatched.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "unmatched", cwd: sourceCwd })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "pi",
      env: {
        ...process.env,
        HOME: home,
        KOED_HOME: koedHome,
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });

    expect(page.items[0]?.projectId).toMatch(/^local-project:/);
    expect(page.items[0]).toMatchObject({ projectName: "tool" });
    expect(JSON.stringify(page)).not.toContain(sourceCwd);
  });

  it("groups unregistered Codex and Pi sources with the same cwd", async () => {
    const home = await makeRoot();
    const koedHome = path.join(home, "koed");
    const sourceCwd = path.join(home, "shared", "workspace");
    const codexRoot = path.join(home, "codex", "sessions");
    const piRoot = path.join(home, "pi", "sessions");
    await Promise.all([
      mkdir(codexRoot, { recursive: true }),
      mkdir(piRoot, { recursive: true })
    ]);
    await writeFile(
      path.join(codexRoot, "rollout.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "same-cwd-codex", cwd: sourceCwd } })}\n`
    );
    await writeFile(
      path.join(piRoot, "session.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "same-cwd-pi", cwd: sourceCwd })}\n`
    );

    const page = await listLocalConversationSources({
      env: {
        ...process.env,
        HOME: home,
        KOED_HOME: koedHome,
        CODEX_HOME: path.join(home, "codex"),
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });
    const bySourceId = new Map(page.items.map((item) => [item.sourceId, item]));

    expect(bySourceId.get("codex:same-cwd-codex")?.projectId).toMatch(
      /^local-project:/
    );
    expect(bySourceId.get("pi:same-cwd-pi")?.projectId).toBe(
      bySourceId.get("codex:same-cwd-codex")?.projectId
    );
    expect(JSON.stringify(page)).not.toContain(sourceCwd);
  });

  it("uses canonical physical cwd identity and keeps existing project IDs stable across worktree discovery", async () => {
    const home = await makeRoot();
    const mainCwd = path.join(home, "workspace", "repo");
    const worktreeCwd = path.join(home, "workspace", "repo-worktree");
    const aliasCwd = path.join(home, "workspace", "repo-alias");
    const piRoot = path.join(home, "pi", "sessions");
    const env = {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: path.join(home, "pi")
    };
    await Promise.all([
      mkdir(path.join(mainCwd, ".git"), { recursive: true }),
      mkdir(piRoot, { recursive: true })
    ]);
    await symlink(mainCwd, aliasCwd, "dir");
    await writeFile(
      path.join(piRoot, "main.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "main", cwd: mainCwd })}\n`
    );
    await writeFile(
      path.join(piRoot, "alias.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "alias", cwd: aliasCwd })}\n`
    );
    await writeFile(
      path.join(piRoot, "trailing.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "trailing", cwd: `${mainCwd}/` })}\n`
    );
    const beforeWorktree = await listLocalConversationSources({
      provider: "pi",
      env
    });
    const stableProjectId = beforeWorktree.items.find(
      (item) => item.sourceId === "pi:main"
    )?.projectId;
    expect(
      beforeWorktree.items.find((item) => item.sourceId === "pi:alias")
        ?.projectId
    ).toBe(stableProjectId);
    expect(
      beforeWorktree.items.find((item) => item.sourceId === "pi:trailing")
        ?.projectId
    ).toBe(stableProjectId);

    const gitDirectory = path.join(mainCwd, ".git");
    const worktreeGitDirectory = path.join(gitDirectory, "worktrees", "linked");
    await mkdir(worktreeGitDirectory, { recursive: true });
    await mkdir(worktreeCwd, { recursive: true });
    await writeFile(
      path.join(gitDirectory, "config"),
      "[core]\n\trepositoryformatversion = 0\n"
    );
    await writeFile(path.join(worktreeGitDirectory, "commondir"), "../..\n");
    await writeFile(
      path.join(worktreeCwd, ".git"),
      `gitdir: ${worktreeGitDirectory}\n`
    );
    await writeFile(
      path.join(piRoot, "worktree.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "worktree", cwd: worktreeCwd })}\n`
    );

    const withWorktree = await listLocalConversationSources({
      provider: "pi",
      env,
      refresh: true
    });
    const byId = new Map(
      withWorktree.items.map((item) => [item.sourceId, item])
    );
    expect(byId.get("pi:main")?.projectId).toBe(stableProjectId);
    expect(byId.get("pi:worktree")?.projectId).toBe(stableProjectId);

    const koedHome = path.join(home, "koed");
    await writeProjectRegistry(koedHome, [
      {
        localProjectId: "lp_registered_main",
        displayName: "Registered main",
        cwd: mainCwd
      }
    ]);
    const registered = await listLocalConversationSources({
      provider: "pi",
      env: { ...env, KOED_HOME: koedHome },
      refresh: true
    });
    const registeredById = new Map(
      registered.items.map((item) => [item.sourceId, item])
    );
    expect(registeredById.get("pi:main")?.projectId).toBe("lp_registered_main");
    expect(registeredById.get("pi:worktree")?.projectId).toBe(
      "lp_registered_main"
    );
  });

  it("maps deleted Codex worktrees only when repository metadata identifies one live checkout", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex");
    const codexRoot = path.join(codexHome, "sessions");
    const archivedRoot = path.join(codexHome, "archived_sessions");
    const mainCwd = path.join(home, "projects", "same-name");
    const otherCwd = path.join(home, "other", "same-name");
    const mainGit = path.join(mainCwd, ".git");
    const otherGit = path.join(otherCwd, ".git");
    const historicalRepoUrl = "https://example.test/team/repository.git";
    const currentRepoUrl = "https://example.test/team/repository-renamed.git";
    await Promise.all([
      mkdir(codexRoot, { recursive: true }),
      mkdir(archivedRoot, { recursive: true }),
      mkdir(mainGit, { recursive: true }),
      mkdir(otherGit, { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        path.join(mainGit, "config"),
        `[remote "origin"]\n\turl = ${currentRepoUrl}\n`
      ),
      writeFile(
        path.join(otherGit, "config"),
        `[remote "origin"]\n\turl = https://example.test/team/another.git\n`
      ),
      writeFile(
        path.join(codexRoot, "main.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "main-repo", cwd: mainCwd, git: { repository_url: historicalRepoUrl } } })}\n`
      ),
      writeFile(
        path.join(codexRoot, "other.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "other-repo", cwd: otherCwd } })}\n`
      ),
      writeFile(
        path.join(archivedRoot, "archived.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "archived-worktree", cwd: path.join(codexHome, "worktrees", "project-id", "same-name"), git: { repository_url: historicalRepoUrl } } })}\n`
      )
    ]);

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });
    const byId = new Map(page.items.map((item) => [item.sourceId, item]));
    expect(byId.get("codex:archived-worktree")?.projectId).toBe(
      byId.get("codex:main-repo")?.projectId
    );
    expect(byId.get("codex:archived-worktree")?.projectId).not.toBe(
      byId.get("codex:other-repo")?.projectId
    );

    const secondMatchingCwd = path.join(home, "third", "same-name");
    const secondMatchingGit = path.join(secondMatchingCwd, ".git");
    await mkdir(secondMatchingGit, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(secondMatchingGit, "config"),
        `[remote "origin"]\n\turl = ${currentRepoUrl}\n`
      ),
      writeFile(
        path.join(codexRoot, "second-match.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "second-match", cwd: secondMatchingCwd, git: { repository_url: historicalRepoUrl } } })}\n`
      )
    ]);
    const ambiguousPage = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      refresh: true
    });
    const ambiguousById = new Map(
      ambiguousPage.items.map((item) => [item.sourceId, item])
    );
    expect(ambiguousById.get("codex:archived-worktree")?.projectId).not.toBe(
      ambiguousById.get("codex:main-repo")?.projectId
    );
    expect(ambiguousById.get("codex:archived-worktree")?.projectId).not.toBe(
      ambiguousById.get("codex:second-match")?.projectId
    );
  });

  it("falls back safely when unrelated registry roots share a local project ID", async () => {
    const home = await makeRoot();
    const koedHome = path.join(home, "koed");
    const firstCwd = path.join(home, "first", "project");
    const secondCwd = path.join(home, "second", "project");
    const piRoot = path.join(home, "pi", "sessions");
    await mkdir(piRoot, { recursive: true });
    await writeProjectRegistry(koedHome, [
      {
        localProjectId: "lp_conflicted_id",
        displayName: "First project",
        cwd: firstCwd
      },
      {
        localProjectId: "lp_conflicted_id",
        displayName: "Second project",
        cwd: secondCwd
      }
    ]);
    await writeFile(
      path.join(piRoot, "first.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "first-conflict", cwd: firstCwd })}\n`
    );
    await writeFile(
      path.join(piRoot, "second.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "second-conflict", cwd: secondCwd })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "pi",
      env: {
        ...process.env,
        HOME: home,
        KOED_HOME: koedHome,
        PI_CODING_AGENT_DIR: path.join(home, "pi")
      }
    });
    const bySourceId = new Map(page.items.map((item) => [item.sourceId, item]));
    const firstProjectId = bySourceId.get("pi:first-conflict")?.projectId;
    const secondProjectId = bySourceId.get("pi:second-conflict")?.projectId;

    expect(firstProjectId).toMatch(/^local-project:/);
    expect(secondProjectId).toMatch(/^local-project:/);
    expect(firstProjectId).not.toBe(secondProjectId);
    expect(firstProjectId).not.toBe("lp_conflicted_id");
    expect(JSON.stringify(page)).not.toContain(home);
  });

  it("reuses a completed scan across cursor pages and refreshes on request", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    const newest = await writeCodexSession(root, "newest");
    const older = await writeCodexSession(root, "older");
    await utimes(
      newest,
      new Date("2026-01-03T00:00:00Z"),
      new Date("2026-01-03T00:00:00Z")
    );
    await utimes(
      older,
      new Date("2026-01-02T00:00:00Z"),
      new Date("2026-01-02T00:00:00Z")
    );

    const firstPage = await listLocalConversationSources({
      provider: "codex",
      env,
      limit: 1
    });
    expect(firstPage.items[0]?.sourceId).toBe("codex:newest");
    expect(firstPage.nextCursor).not.toBeNull();

    const newlyAdded = await writeCodexSession(root, "added-after-scan");
    await utimes(
      newlyAdded,
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z")
    );
    const secondPage = await listLocalConversationSources({
      provider: "codex",
      env,
      limit: 10,
      cursor: firstPage.nextCursor ?? undefined
    });
    expect(secondPage.items.map((item) => item.sourceId)).toEqual([
      "codex:older"
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const refreshed = await listLocalConversationSources({
      provider: "codex",
      env,
      limit: 10,
      refresh: true
    });
    expect(refreshed.items.map((item) => item.sourceId)).toContain(
      "codex:added-after-scan"
    );
    expect(refreshed.items).toHaveLength(3);
  });

  it("expires completed scans after the short cache lifetime", async () => {
    vi.useFakeTimers();
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    await writeCodexSession(root, "before-expiry");
    const initial = await listLocalConversationSources({
      provider: "codex",
      env
    });
    expect(initial.items).toHaveLength(1);

    await writeCodexSession(root, "after-expiry");
    const stillCached = await listLocalConversationSources({
      provider: "codex",
      env
    });
    expect(stillCached.items).toHaveLength(1);

    vi.setSystemTime(Date.now() + 30_001);
    const expired = await listLocalConversationSources({
      provider: "codex",
      env
    });
    expect(expired.items).toHaveLength(2);
  });

  it("isolates provider and filesystem scopes and evicts old scopes", async () => {
    const firstHome = await makeRoot();
    const firstCodexHome = path.join(firstHome, "codex-home");
    const firstRoot = path.join(firstCodexHome, "sessions");
    await mkdir(firstRoot, { recursive: true });
    await writeCodexSession(firstRoot, "first-scope");
    const firstEnv = {
      ...process.env,
      HOME: firstHome,
      CODEX_HOME: firstCodexHome
    };
    await listLocalConversationSources({ provider: "codex", env: firstEnv });

    const secondHome = await makeRoot();
    const secondCodexHome = path.join(secondHome, "codex-home");
    const secondRoot = path.join(secondCodexHome, "sessions");
    await mkdir(secondRoot, { recursive: true });
    await writeCodexSession(secondRoot, "second-scope");
    const secondEnv = {
      ...process.env,
      HOME: secondHome,
      CODEX_HOME: secondCodexHome
    };
    const secondScope = await listLocalConversationSources({
      provider: "codex",
      env: secondEnv
    });
    expect(secondScope.items.map((item) => item.sourceId)).toEqual([
      "codex:second-scope"
    ]);

    const piHome = path.join(secondHome, "pi-home");
    const piRoot = path.join(piHome, "sessions");
    await mkdir(piRoot, { recursive: true });
    await writeFile(
      path.join(piRoot, "pi.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "pi-only" })}\n`
    );
    const piPage = await listLocalConversationSources({
      provider: "pi",
      env: { ...secondEnv, PI_CODING_AGENT_DIR: piHome }
    });
    expect(piPage.items.map((item) => item.sourceId)).toEqual(["pi:pi-only"]);
    expect(piPage.providers.codex.status).toBe("not_requested");

    const evictionHomes = [firstHome, secondHome];
    while (evictionHomes.length < 7) evictionHomes.push(await makeRoot());
    for (let index = 2; index < evictionHomes.length; index += 1) {
      const home = evictionHomes[index]!;
      const codexHome = path.join(home, "codex-home");
      const root = path.join(codexHome, "sessions");
      await mkdir(root, { recursive: true });
      await writeCodexSession(root, `eviction-${index}`);
      await listLocalConversationSources({
        provider: "codex",
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
      });
    }
    await writeCodexSession(firstRoot, "after-eviction");
    const rescanned = await listLocalConversationSources({
      provider: "codex",
      env: firstEnv
    });
    expect(rescanned.items).toHaveLength(2);
  });

  it("uses recent-first cursor pages and includes old sessions without an age cutoff", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const files = [
      { id: "alpha", day: 3 },
      { id: "zeta", day: 1 },
      { id: "middle", day: 2 }
    ];
    for (const { id, day } of files) {
      const file = path.join(root, `rollout-${id}.jsonl`);
      await writeFile(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`
      );
      const date = new Date(Date.UTC(2020, 0, day));
      await utimes(file, date, date);
    }
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
    const first = await listLocalConversationSources({ env, limit: 1 });
    const second = await listLocalConversationSources({
      env,
      limit: 1,
      cursor: first.nextCursor ?? undefined
    });
    const third = await listLocalConversationSources({
      env,
      limit: 1,
      cursor: second.nextCursor ?? undefined
    });

    expect(first.items.map((item) => item.sourceId)).toEqual(["codex:alpha"]);
    expect(second.items.map((item) => item.sourceId)).toEqual(["codex:middle"]);
    expect(third.items.map((item) => item.sourceId)).toEqual(["codex:zeta"]);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set([
        first.items[0]!.title,
        second.items[0]!.title,
        third.items[0]!.title
      ]).size
    ).toBe(3);
  });

  it("uses a sanitized, bounded first Codex user prompt as the display title", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const prompt = `  Summarize\t the  incident\nfor the on-call team ${"private detail ".repeat(30)}`;
    const file = path.join(root, "rollout-title.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "title-session" }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: prompt }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "assistant response" }
        })
      ].join("\n") + "\n"
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });
    const title = page.items[0]?.title ?? "";

    expect(title).toMatch(/^Summarize the incident for the on-call team/);
    expect(title).toHaveLength(100);
    expect(title).not.toMatch(/[\n\t\r]/);
    expect(JSON.stringify(page)).not.toContain(prompt);
    expect(JSON.stringify(page)).not.toContain("assistant response");
  });

  it("skips an AGENTS instruction preamble and uses the actual Codex IDE request", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    await mkdir(root, { recursive: true });
    const id = "preamble-session";
    const instructionPreamble = `<recommended_plugins>\n- Figma (app@example)\n</recommended_plugins>\n\n# AGENTS.md instructions for /private/project\n\n<INSTRUCTIONS>\nFollow these repository rules and keep all local setup context intact.\n</INSTRUCTIONS>`;
    const wrappedRequest = `<environment_context>\n  <cwd>/private/project</cwd>\n</environment_context>\n\n# Context from my IDE setup:\n\n## Active file: src/retry.ts\n\n## My request for Codex:\nFix the retry backoff when the server returns 429.`;
    const file = path.join(root, "rollout-preamble.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: instructionPreamble }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: wrappedRequest }
        })
      ].join("\n") + "\n"
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items[0]?.title).toBe(
      "Fix the retry backoff when the server returns 429."
    );
    expect(JSON.stringify(page)).not.toContain("AGENTS.md instructions");
    expect(JSON.stringify(page)).not.toContain("recommended_plugins");
    expect(JSON.stringify(page)).not.toContain("Follow these repository rules");
    expect(JSON.stringify(page)).not.toContain("/private/project");
  });

  it("scans only the requested provider and reports other providers as unrequested", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const codexRoot = path.join(codexHome, "sessions");
    await mkdir(codexRoot, { recursive: true });
    await writeFile(
      path.join(codexRoot, "rollout-one.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "one" } })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items.map((item) => item.provider)).toEqual(["codex"]);
    expect(page.providers).toMatchObject({
      codex: { status: "available" },
      "claude-code": { status: "not_requested" },
      pi: { status: "not_requested" }
    });
  });

  it("does not assign a generic Claude project name when transcript metadata is absent", async () => {
    const home = await makeRoot();
    const claudeHome = path.join(home, "claude-home");
    const projectRoot = path.join(claudeHome, "projects", "private-project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, "123e4567-e89b-42d3-a456-426614174000.jsonl"),
      `${JSON.stringify({ sessionId: "123e4567-e89b-42d3-a456-426614174000", message: { content: "secret" } })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "claude-code",
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeHome }
    });

    expect(page.items[0]).toMatchObject({ provider: "claude-code" });
    expect(page.items[0]).not.toHaveProperty("projectName");
    expect(JSON.stringify(page)).not.toContain("private-project");
    expect(JSON.stringify(page)).not.toContain("secret");
  });

  it("skips Claude files whose bounded session identity does not match the filename", async () => {
    const home = await makeRoot();
    const claudeHome = path.join(home, "claude-home");
    const projectRoot = path.join(claudeHome, "projects", "project-one");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, "123e4567-e89b-42d3-a456-426614174000.jsonl"),
      `${JSON.stringify({ sessionId: "123e4567-e89b-42d3-a456-426614174001", cwd: "/work/wrong" })}\n`
    );

    const page = await listLocalConversationSources({
      provider: "claude-code",
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeHome }
    });

    expect(page.items).toEqual([]);
    expect(page.providers["claude-code"]).toEqual({
      status: "partial",
      code: "source_identity_invalid"
    });
  });

  it("finds Claude identity in a later bounded record when the first record lacks sessionId", async () => {
    const home = await makeRoot();
    const claudeHome = path.join(home, "claude-home");
    const projectRoot = path.join(claudeHome, "projects", "project-one");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, `${id}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          message: { content: "private prompt" }
        }),
        JSON.stringify({
          sessionId: id,
          cwd: "/work/verified-project",
          message: { content: "private reply" }
        })
      ].join("\n") + "\n"
    );

    const page = await listLocalConversationSources({
      provider: "claude-code",
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeHome }
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sourceId: `claude-code:${id}`,
      projectName: "verified-project"
    });
    expect(JSON.stringify(page)).not.toContain("private prompt");
    expect(JSON.stringify(page)).not.toContain("private reply");
  });

  it("deduplicates copied Codex sources before cursor pagination and keeps the newest verified copy", async () => {
    const home = await makeRoot();
    const olderRoot = path.join(home, "codex-copy-a");
    const newerRoot = path.join(home, "codex-copy-b");
    await Promise.all([mkdir(olderRoot), mkdir(newerRoot)]);
    const older = path.join(olderRoot, "rollout-copy.jsonl");
    const newer = path.join(newerRoot, "rollout-copy.jsonl");
    const id = "same-session-id";
    await Promise.all([
      writeFile(
        older,
        `${JSON.stringify({ type: "session_meta", payload: { id, title: "Older copy" } })}\n`
      ),
      writeFile(
        newer,
        `${JSON.stringify({ type: "session_meta", payload: { id, title: "Newer copy" } })}\n`
      )
    ]);
    const oldTime = new Date("2022-01-01T00:00:00.000Z");
    const newTime = new Date("2024-01-01T00:00:00.000Z");
    await Promise.all([
      utimes(older, oldTime, oldTime),
      utimes(newer, newTime, newTime)
    ]);

    const page = await listLocalConversationSources({
      env: {
        ...process.env,
        HOME: home,
        MEMORY_CODEX_TRANSCRIPT_ROOTS: [olderRoot, newerRoot].join(
          path.delimiter
        )
      },
      limit: 1
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sourceId: "codex:same-session-id",
      title: "Newer copy"
    });
    expect(page.nextCursor).toBeNull();
  });

  it("rejects symlinked transcript files without exposing their targets", async () => {
    const home = await makeRoot();
    const codexHome = path.join(home, "codex-home");
    const root = path.join(codexHome, "sessions");
    const outside = path.join(home, "outside.jsonl");
    await mkdir(root, { recursive: true });
    await writeFile(
      outside,
      `${JSON.stringify({ type: "session_meta", payload: { id: "outside-session" } })}\n`
    );
    await symlink(outside, path.join(root, "rollout-link.jsonl"));

    const page = await listLocalConversationSources({
      provider: "codex",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
    });

    expect(page.items).toEqual([]);
    expect(page.providers.codex).toMatchObject({
      status: "partial",
      code: "source_identity_invalid"
    });
    expect(JSON.stringify(page)).not.toContain(home);
  });

  it("reports missing roots and rejects malformed cursors without leaking paths", async () => {
    const home = await makeRoot();
    const missing = await listLocalConversationSources({
      env: { ...process.env, HOME: home }
    });
    expect(missing.items).toEqual([]);
    expect(missing.providers.codex).toEqual({
      status: "unavailable",
      code: "source_root_missing"
    });
    await expect(
      listLocalConversationSources({
        cursor: "not-a-cursor",
        env: { ...process.env, HOME: home }
      })
    ).rejects.toThrow("local_conversation_cursor_invalid");
    expect(JSON.stringify(missing)).not.toContain(home);
  });
});
