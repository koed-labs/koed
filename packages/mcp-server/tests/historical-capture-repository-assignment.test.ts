import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  updateSessionRepositoryOverride
} from "@koed/db";
import {
  resolveHistoricalCaptureRepositoryIdentity,
  codexSourceTimeRepositoryIdentity
} from "../src/historical-repository-context.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("historical import assignment boundary", () => {
  let pool: ReturnType<typeof createDbPool>;
  let repository: ReturnType<typeof createMemorySourceRepository>;
  const directories: string[] = [];
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    repository = createMemorySourceRepository(pool);
    await runDbMigrations(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    for (const directory of directories)
      fs.rmSync(directory, { recursive: true, force: true });
  });
  it.each(["codex-cli", "claude-code", "pi"] as const)(
    "preserves %s import assignments and unresolved history",
    async (sourceRuntime) => {
      const user = await repository.createUser({
        email: `historical-${randomUUID()}@example.test`
      });
      const actor = { userId: user.id };
      fs.mkdirSync(path.resolve("scratch/historical-project-imports"), {
        recursive: true
      });
      const directory = fs.mkdtempSync(
        path.resolve("scratch/historical-project-imports/database-")
      );
      directories.push(directory);
      const cwd = path.join(directory, "checkout");
      fs.mkdirSync(cwd);
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
      git("init");
      git("remote", "add", "origin", "https://example.test/team/source.git");
      const sourceTime =
        sourceRuntime === "codex-cli"
          ? codexSourceTimeRepositoryIdentity([
              {
                type: "session_meta",
                payload: {
                  cwd,
                  timestamp: "2025-01-01T00:00:00Z",
                  git: {
                    repository_url: "https://example.test/team/source.git",
                    branch: "main"
                  }
                }
              }
            ])
          : null;
      const identity = await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime,
        cwd,
        env: { KOED_HOME: path.join(directory, "koed") }
      });
      const input = {
        sourceRuntime,
        externalSessionId: randomUUID(),
        cwd,
        repositoryIdentity: identity,
        metadata: { sourceTransport: "historical_import" }
      };
      const captured = await repository.createCapturedSession(actor, input);
      expect(captured.repositoryAssignment?.effective).toEqual(identity);
      expect(captured.repositoryAssignment?.effective?.kind).toBe(
        "portable_repository"
      );
      const other = {
        ...identity,
        kind: "portable_repository" as const,
        key: "gr_current_checkout",
        root: "/reused/path"
      };
      const replay = await repository.createCapturedSession(actor, {
        ...input,
        cwd: "/reused/path",
        repositoryIdentity: other
      });
      expect(replay.id).toBe(captured.id);
      expect(replay.repositoryAssignment).toEqual(
        captured.repositoryAssignment
      );
      const override = await updateSessionRepositoryOverride(pool, {
        ownerUserId: user.id,
        sessionId: captured.id,
        expectedVersion: 1,
        identity: other
      });
      expect(
        (await repository.createCapturedSession(actor, input))
          .repositoryAssignment
      ).toEqual(override);
      expect(
        (await repository.resetCapturedSessionProject(actor, captured.id, 2))
          ?.repositoryAssignment?.effective
      ).toEqual(identity);
      await pool.query(
        "update sessions set repository_assignment_state='historical_unresolved',repository_automatic_identity=null,repository_override_identity=null where id=$1",
        [captured.id]
      );
      const continued = await repository.createCapturedSession(actor, input);
      expect(continued.id).toBe(captured.id);
      expect(continued.repositoryAssignment).toMatchObject({
        state: "historical_unresolved",
        automatic: null,
        effective: null
      });
      await pool.query("update sessions set invalidated_at=now() where id=$1", [
        captured.id
      ]);
      const reimported = await repository.createCapturedSession(actor, {
        ...input,
        idempotencyKey: randomUUID(),
        logicalSessionId: randomUUID()
      });
      expect(reimported.repositoryAssignment).toMatchObject({
        state: "historical_unresolved",
        automatic: null,
        override: null,
        effective: null
      });
    }
  );

  it.each(["codex-cli", "claude-code", "pi"] as const)(
    "does not replace a recorded %s folder assignment when Git becomes available",
    async (sourceRuntime) => {
      const user = await repository.createUser({
        email: `folder-replay-${randomUUID()}@example.test`
      });
      const actor = { userId: user.id };
      fs.mkdirSync(path.resolve("scratch/historical-project-imports"), {
        recursive: true
      });
      const directory = fs.mkdtempSync(
        path.resolve("scratch/historical-project-imports/replay-")
      );
      directories.push(directory);
      const cwd = path.join(directory, "checkout");
      const env = { KOED_HOME: path.join(directory, "koed") };
      const folderIdentity = await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      });
      expect(folderIdentity.kind).toBe("non_git_project");
      const input = {
        sourceRuntime,
        externalSessionId: randomUUID(),
        cwd,
        metadata: { sourceTransport: "historical_import" }
      };
      const original = await repository.createCapturedSession(actor, {
        ...input,
        repositoryIdentity: folderIdentity
      });
      fs.mkdirSync(cwd);
      execFileSync("git", ["-C", cwd, "init"], { stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-C",
          cwd,
          "remote",
          "add",
          "origin",
          "https://example.test/team/available.git"
        ],
        { stdio: "pipe" }
      );
      const current = await resolveHistoricalCaptureRepositoryIdentity({
        sourceTime: null,
        cwd,
        env
      });
      expect(current.kind).toBe("portable_repository");
      const replay = await repository.createCapturedSession(actor, {
        ...input,
        repositoryIdentity: current
      });
      expect(replay.id).toBe(original.id);
      expect(replay.repositoryAssignment).toEqual(
        original.repositoryAssignment
      );
    }
  );
});
