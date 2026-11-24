import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClientWorktreeLookup as lookupFor } from "./client-worktree-source.js";

const claude = (id: string | null) => ({
  sourceRuntime: "claude-code",
  externalSessionId: id
});
const cwd = "/work/koed/.claude/worktrees/task";

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
  it("shares an asynchronous index across hits and misses for one batch", async () => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    write(homeDir, "local_2.json", session({ cliSessionId: "cli-2" }));
    const lookup = lookupFor({ homeDir });
    const first = lookup(claude("cli-missing"), cwd);
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBeNull();
    write(homeDir, "local_1.json", "{}");
    write(homeDir, "local_2.json", "{}");
    write(homeDir, "new.json", session({ cliSessionId: "cli-missing" }));
    expect(await lookup(claude("cli-1"), cwd)).toEqual({
      state: "worktree",
      originPath: "/work/koed"
    });
    expect(await lookup(claude("cli-2"), cwd)).not.toBeNull();
    expect(await lookup(claude("cli-missing"), cwd)).toBeNull();
    expect(await lookup(claude("cli-never-seen"), cwd)).toBeNull();
  });

  it("counts directories against the visited-entry budget", async () => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    // The record is the third visited entry (a, b, local_1.json).
    const lookup = lookupFor({ homeDir, maxEntries: 2 });
    expect(await lookup(claude("cli-1"), cwd)).toBeNull();
  });

  it("caps total bytes read across records, including UTF-8 multibyte data", async () => {
    const homeDir = home();
    const body = (id: string) =>
      JSON.stringify(session({ cliSessionId: id, padding: "é".repeat(300) }));
    write(homeDir, "local_1.json", body("cli-1"));
    write(homeDir, "local_2.json", body("cli-2"));
    // Both would fit if counted in characters; only one fits in bytes.
    const lookup = lookupFor({ homeDir, maxBytes: 1100 });
    const results = await Promise.all([
      lookup(claude("cli-1"), cwd),
      lookup(claude("cli-2"), cwd)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("reads the main project directory the client recorded for a worktree session", async () => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    expect(await lookupFor({ homeDir })(claude("cli-1"), cwd)).toEqual({
      state: "worktree",
      originPath: "/work/koed"
    });
  });

  it("reports a session that ran in its own project directory, and matches prior session ids", async () => {
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
      await lookupFor({ homeDir })(claude("cli-old"), "/work/koed")
    ).toEqual({ state: "not-a-worktree" });
  });

  it.each([
    ["an unknown session id", "cli-9", "/work/koed/.claude/worktrees/task"],
    ["a different recorded directory", "cli-1", "/work/other"],
    ["no session id", null, "/work/koed/.claude/worktrees/task"]
  ])("returns nothing for %s", async (_name, id, cwd) => {
    const homeDir = home();
    write(homeDir, "local_1.json", session());
    expect(await lookupFor({ homeDir })(claude(id), cwd)).toBeNull();
  });

  it("ignores malformed, unfamiliar, or relative records", async () => {
    const homeDir = home();
    write(homeDir, "bad.json", "{ cli-1");
    write(homeDir, "odd.json", session({ originCwd: "relative/path" }));
    write(homeDir, "list.json", ["cli-1"]);
    expect(await lookupFor({ homeDir })(claude("cli-1"), cwd)).toBeNull();
  });

  it("skips non-Claude clients without starting the index", async () => {
    const homeDir = home();
    const lookup = lookupFor({ homeDir });
    expect(
      await lookup({ sourceRuntime: "codex", externalSessionId: "cli-1" }, cwd)
    ).toBeNull();
    write(homeDir, "local_1.json", session());
    expect(await lookup(claude("cli-1"), cwd)).not.toBeNull();
  });

  it("handles a missing client record directory", async () => {
    const lookup = lookupFor({ homeDir: resolve(home(), "missing") });
    expect(await lookup(claude("cli-1"), cwd)).toBeNull();
  });
});
