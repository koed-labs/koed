import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectMoveLocalJournal,
  type ProjectMoveLocalJournalRecord
} from "./project-move-local-journal.js";

const homes: string[] = [];
const makeHome = (): string => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-project-move-journal-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const binding = (): ProjectMoveLocalJournalRecord["sourceRuntimeBinding"] => ({
  executionId: "10000000-0000-4000-8000-000000000001",
  ownerUserId: "10000000-0000-4000-8000-000000000002",
  deploymentId: "10000000-0000-4000-8000-000000000003",
  deviceId: "10000000-0000-4000-8000-000000000004",
  executionGeneration: 2,
  sourceProjectPath: "/work/source",
  projectPath: "/work/source",
  checkoutId: null,
  checkoutKind: "user_managed_checkout",
  checkoutLifecycle: "ready",
  cleanupState: "not_requested",
  vcsDriver: "git",
  localRepositoryCommonDirectory: "/work/source/.git",
  localGitDirectory: "/work/source/.git",
  repositoryIdentityHash: "repository-hash",
  worktreeIdentityHash: "worktree-hash",
  baseRef: "main",
  baseObjectId: "a".repeat(40),
  branchRef: "refs/heads/feature",
  headObjectId: "b".repeat(40),
  creationOperationId: null,
  localSessionId: "session-1",
  providerThreadId: "thread-1",
  transcriptPath: "/home/user/.koed/transcripts/thread.jsonl",
  managedHome: "/home/user/.koed/managed",
  providerCliVersion: "1.0.0",
  sourceGenerationId: null,
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:01:00.000Z"
});

const record = (
  overrides: Partial<ProjectMoveLocalJournalRecord> = {}
): ProjectMoveLocalJournalRecord => ({
  schemaVersion: 1,
  moveId: "20000000-0000-4000-8000-000000000001",
  sourceRuntimeBinding: binding(),
  sourceProjectId: "local-project-a",
  destinationProjectId: "local-project-b",
  destinationLocalPath: "/work/destination",
  phase: "requested",
  updatedAt: "2026-09-26T10:02:00.000Z",
  ...overrides
});

describe("ProjectMoveLocalJournal", () => {
  it("atomically persists and reloads a private local recovery record", () => {
    const home = makeHome();
    const journal = new ProjectMoveLocalJournal({ koedHome: home });
    const value = record();

    journal.write(value);

    expect(journal.read(value.moveId)).toEqual(value);
    expect(journal.list()).toEqual([value]);
    const directory = resolve(home, "run", "project-moves");
    const file = resolve(directory, `${value.moveId}.json`);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("/work/destination");

    journal.write({
      ...value,
      phase: "source_quiesced",
      updatedAt: "2026-09-26T10:03:00.000Z"
    });
    expect(journal.read(value.moveId)?.phase).toBe("source_quiesced");
    journal.remove(value.moveId);
    expect(journal.read(value.moveId)).toBeNull();
  });

  it("rejects traversal ids, malformed records, and a symlinked journal directory", () => {
    const home = makeHome();
    const journal = new ProjectMoveLocalJournal({ koedHome: home });
    expect(() => journal.read("../outside")).toThrow();
    expect(() =>
      journal.write(record({ destinationLocalPath: "/work/../outside" }))
    ).toThrow();

    journal.write(record());
    const recordPath = resolve(
      home,
      "run",
      "project-moves",
      `${record().moveId}.json`
    );
    writeFileSync(
      recordPath,
      JSON.stringify({ ...record(), phase: "unknown" }),
      {
        mode: 0o600
      }
    );
    expect(() => journal.read(record().moveId)).toThrow();

    const symlinkHome = makeHome();
    const symlinkJournal = new ProjectMoveLocalJournal({
      koedHome: symlinkHome
    });
    const run = resolve(symlinkHome, "run");
    const outside = resolve(symlinkHome, "outside");
    const journalPath = resolve(run, "project-moves");
    // Create the expected parent, then redirect the journal child elsewhere.
    mkdirSync(run, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, journalPath, "dir");
    expect(() => symlinkJournal.write(record())).toThrow(/unsafe/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
