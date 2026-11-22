import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudeWorktreeLink,
  readClientWorktreeLink
} from "./client-worktree-source.js";

const temporary: string[] = [];
const home = () => {
  const parent = resolve(
    import.meta.dirname,
    "../../../scratch/folder-hint/local"
  );
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "client-"));
  temporary.push(root);
  mkdirSync(
    resolve(
      root,
      "Library/Application Support/Claude/claude-code-sessions/a/b"
    ),
    { recursive: true }
  );
  return root;
};
const write = (root: string, name: string, body: unknown) =>
  writeFileSync(
    resolve(
      root,
      "Library/Application Support/Claude/claude-code-sessions/a/b",
      name
    ),
    typeof body === "string" ? body : JSON.stringify(body)
  );
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const session = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "local_1",
  cliSessionId: "cli-1",
  cwd: "/work/koed/.claude/worktrees/task",
  originCwd: "/work/koed",
  worktreePath: "/work/koed/.claude/worktrees/task",
  ...overrides
});

describe("Claude desktop worktree link", () => {
  it("reads the main project directory the client recorded for a worktree session", () => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    expect(
      readClaudeWorktreeLink("cli-1", "/work/koed/.claude/worktrees/task", {
        homeDir
      })
    ).toEqual({ state: "worktree", originPath: "/work/koed" });
  });

  it("reports a session that ran in its own project directory, and matches prior session ids", () => {
    const homeDir = home();
    write(
      homeDir,
      "local_2.json",
      session({
        cliSessionId: "cli-2",
        priorCliSessionIds: ["cli-old"],
        cwd: "/work/koed",
        worktreePath: undefined
      })
    );
    expect(
      readClaudeWorktreeLink("cli-old", "/work/koed", { homeDir })
    ).toEqual({ state: "not-a-worktree" });
  });

  it.each([
    ["an unknown session id", "cli-9", "/work/koed/.claude/worktrees/task"],
    ["a different recorded directory", "cli-1", "/work/other"],
    ["no session id", null, "/work/koed/.claude/worktrees/task"]
  ])("returns nothing for %s", (_name, id, cwd) => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    expect(readClaudeWorktreeLink(id, cwd, { homeDir })).toBeNull();
  });

  it("ignores malformed, unfamiliar, or relative records", () => {
    const homeDir = home();
    write(homeDir, "bad.json", "{ cli-1");
    write(homeDir, "odd.json", session({ originCwd: "relative/path" }));
    write(homeDir, "list.json", ["cli-1"]);
    expect(
      readClaudeWorktreeLink("cli-1", "/work/koed/.claude/worktrees/task", {
        homeDir
      })
    ).toBeNull();
  });

  it("reads a client record only for Claude Code and without a home directory present", () => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    const cwd = "/work/koed/.claude/worktrees/task";
    expect(
      readClientWorktreeLink(
        { sourceRuntime: "codex", externalSessionId: "cli-1" },
        cwd,
        { homeDir }
      )
    ).toBeNull();
    expect(
      readClientWorktreeLink(
        { sourceRuntime: "claude-code", externalSessionId: "cli-1" },
        cwd,
        { homeDir: resolve(homeDir, "missing") }
      )
    ).toBeNull();
  });
});
