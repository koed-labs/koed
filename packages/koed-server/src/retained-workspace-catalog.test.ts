import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RetainedWorkspaceCatalog,
  type RetainedWorkspaceRecord
} from "./retained-workspace-catalog.js";

const homes: string[] = [];
const makeHome = (): string => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-retained-workspace-"));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const record = (index = 1): RetainedWorkspaceRecord => ({
  schemaVersion: 2,
  moveId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  executionId: "10000000-0000-4000-8000-000000000001",
  executionGeneration: 2,
  sourceProjectId: "local-project-a",
  destinationProjectId: "local-project-b",
  sourcePath: "/work/source",
  destinationPath: "/work/destination",
  providerThreadId: "thread-1",
  checkoutKind: "user_managed_checkout",
  checkoutIdentity: {
    checkoutId: "30000000-0000-4000-8000-000000000001",
    vcsDriver: "git",
    ownership: "user_managed_checkout",
    canonicalPath: "/work/source",
    localRepositoryCommonDirectory: "/work/source/.git",
    localGitDirectory: "/work/source/.git",
    repositoryIdentityHash: "a".repeat(64),
    worktreeIdentityHash: "b".repeat(64),
    baseRef: "refs/heads/main",
    baseObjectId: "c".repeat(40),
    branchRef: "refs/heads/main",
    headObjectId: "c".repeat(40)
  },
  reason: "changed",
  retainedAt: "2026-09-26T10:02:00.000Z"
});

describe("RetainedWorkspaceCatalog", () => {
  it("atomically persists restart-readable private locators without a routine move cap", () => {
    const home = makeHome();
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    for (let index = 1; index <= 140; index++) catalog.upsert(record(index));
    const restartedCatalog = new RetainedWorkspaceCatalog({ koedHome: home });
    expect(restartedCatalog.list()).toHaveLength(140);
    expect(restartedCatalog.read(record(1).moveId)).toEqual(record(1));
    const directory = resolve(home, "run", "retained-workspaces");
    const filename = resolve(directory, `${record(1).moveId}.json`);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(filename).mode & 0o777).toBe(0o600);
    expect(readFileSync(filename, "utf8")).toContain("/work/source");
    expect(readdirSync(directory)).toHaveLength(140);
  });

  it("supports reconciliation upserts and explicit record removal without touching source files", () => {
    const home = makeHome();
    const source = resolve(home, "source");
    writeFileSync(source, "keep");
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    catalog.upsert({ ...record(), reason: "unknown" });
    expect(catalog.read(record().moveId)?.reason).toBe("unknown");
    catalog.remove(record().moveId);
    expect(catalog.read(record().moveId)).toBeNull();
    expect(readFileSync(source, "utf8")).toBe("keep");
  });

  it("rejects traversal ids and malformed on-disk entries", () => {
    const home = makeHome();
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    expect(() => catalog.read("../outside")).toThrow();
    catalog.upsert(record());
    writeFileSync(
      resolve(home, "run", "retained-workspaces", `${record().moveId}.json`),
      JSON.stringify({ ...record(), reason: "other" }),
      { mode: 0o600 }
    );
    expect(() => catalog.list()).toThrow();
  });

  it("loads legacy records as non-deletable unknown locators", () => {
    const home = makeHome();
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    const legacyRecord = {
      schemaVersion: 1,
      moveId: record().moveId,
      executionId: record().executionId,
      executionGeneration: 1,
      sourceProjectId: "local-project-a",
      destinationProjectId: "local-project-b",
      sourcePath: "/work/source",
      destinationPath: "/work/destination",
      providerThreadId: "thread-1",
      reason: "changed",
      retainedAt: "2026-09-26T10:02:00.000Z"
    };
    const directory = resolve(home, "run", "retained-workspaces");
    catalog.upsert(record());
    writeFileSync(
      resolve(directory, `${legacyRecord.moveId}.json`),
      JSON.stringify(legacyRecord),
      { mode: 0o600 }
    );
    expect(catalog.read(record().moveId)).toMatchObject({
      schemaVersion: 2,
      checkoutKind: "unknown",
      checkoutIdentity: null
    });
  });

  it("deletes only an explicitly confirmed Koed-managed worktree, then removes its record", async () => {
    const home = makeHome();
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    const managed = {
      ...record(),
      checkoutKind: "koed_managed_worktree" as const,
      checkoutIdentity: {
        ...record().checkoutIdentity!,
        ownership: "koed_managed_worktree" as const
      }
    };
    const removeRetainedManagedWorktree = vi.fn(async () => undefined);
    const driver = {
      removeRetainedManagedWorktree
    } as never;
    catalog.upsert(managed);

    await expect(
      catalog.removeManagedWorktree(
        managed.moveId,
        driver,
        "delete_managed_worktree"
      )
    ).resolves.toBe(true);
    expect(removeRetainedManagedWorktree).toHaveBeenCalledWith(
      managed.checkoutIdentity
    );
    expect(catalog.read(managed.moveId)).toBeNull();
  });

  it.each([
    {
      kind: "user_managed_checkout" as const,
      identity: record().checkoutIdentity
    },
    { kind: "unknown" as const, identity: null }
  ])("never deletes $kind source files", async ({ kind, identity }) => {
    const home = makeHome();
    const source = resolve(home, "source");
    writeFileSync(source, "keep");
    const catalog = new RetainedWorkspaceCatalog({ koedHome: home });
    const retained = {
      ...record(),
      sourcePath: source,
      checkoutKind: kind,
      checkoutIdentity: identity ? { ...identity, canonicalPath: source } : null
    };
    catalog.upsert(retained);
    const removeRetainedManagedWorktree = vi.fn(async () => undefined);
    const driver = { removeRetainedManagedWorktree } as never;

    await expect(
      catalog.removeManagedWorktree(
        retained.moveId,
        driver,
        "delete_managed_worktree"
      )
    ).rejects.toThrow("not a deletable managed worktree");
    expect(removeRetainedManagedWorktree).not.toHaveBeenCalled();
    expect(readFileSync(source, "utf8")).toBe("keep");
  });
});
