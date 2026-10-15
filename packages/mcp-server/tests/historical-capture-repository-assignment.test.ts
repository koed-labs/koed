import fs from "node:fs";
import os from "node:os";
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
  const pool = createDbPool({ connectionString: databaseUrl });
  const repository = createMemorySourceRepository(pool);
  const directories: string[] = [];
  beforeAll(() => runDbMigrations(pool), 60_000);
  afterAll(async () => {
    await pool.end();
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
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-historical-import-")
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
        sourceRuntime === "codex-cli" ? "portable_repository" : "unresolved"
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
    }
  );
});
