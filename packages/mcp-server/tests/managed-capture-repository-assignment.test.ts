import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations,
  updateSessionRepositoryOverride
} from "@koed/db";
import { repositoryScopeId } from "@koed/shared";
import { resolveCaptureRepositoryIdentity } from "../src/capture-repository-context.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("managed target to capture assignment", () => {
  let pool: ReturnType<typeof createDbPool>;
  let repository: ReturnType<typeof createMemorySourceRepository>;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    repository = createMemorySourceRepository(pool);
    await runDbMigrations(pool);
  }, 60_000);
  afterAll(() => pool?.end());
  describe.each(["codex", "claude-code", "pi"] as const)(
    "%s",
    (sourceRuntime) => {
      it.each(["root", "worktree", "standalone"])(
        "retains target %s through duplicate capture and historical continuation",
        async (checkout) => {
          const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), "koed-managed-capture-")
          );
          try {
            const root = path.join(directory, "project");
            fs.mkdirSync(root);
            const git = (...args: string[]) =>
              execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
            git("init");
            git(
              "remote",
              "add",
              "origin",
              "https://example.test/team/managed.git"
            );
            git(
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "commit",
              "--allow-empty",
              "-m",
              "Fixture"
            );
            const target =
              checkout === "root" ? root : path.join(directory, checkout);
            if (checkout === "worktree")
              git("worktree", "add", "-b", "preview", target);
            if (checkout === "standalone") fs.mkdirSync(target);
            const identity = await resolveCaptureRepositoryIdentity({
              cwd: target,
              env: { KOED_HOME: path.join(directory, "koed") }
            });
            expect(identity?.kind).toBe(
              checkout === "standalone"
                ? "non_git_project"
                : "portable_repository"
            );
            if (
              !identity ||
              (identity.kind !== "portable_repository" &&
                identity.kind !== "non_git_project")
            )
              throw new Error("Expected a resolved captured checkout");
            expect(fs.realpathSync(identity.root!)).toBe(
              fs.realpathSync(target)
            );
            const user = await repository.createUser({
              email: `managed-capture-${randomUUID()}@example.test`
            });
            const actor = { userId: user.id };
            const input = {
              sourceRuntime,
              externalSessionId: randomUUID(),
              logicalSessionId: randomUUID(),
              projectId: randomUUID(),
              cwd: target,
              repositoryIdentity: identity
            };
            const captured = await repository.createCapturedSession(
              actor,
              input
            );
            expect(captured.repositoryAssignment?.effective).toEqual(identity);
            expect(captured.automaticProject?.id).toBe(
              repositoryScopeId(identity)
            );
            const duplicate = await repository.createCapturedSession(actor, {
              ...input,
              cwd: process.cwd(),
              repositoryIdentity: { ...identity, key: "gr_other" }
            });
            expect(duplicate.id).toBe(captured.id);
            expect(duplicate.repositoryAssignment).toEqual(
              captured.repositoryAssignment
            );
            expect(duplicate.cwd).toBe(target);
            const override = await updateSessionRepositoryOverride(pool, {
              ownerUserId: user.id,
              sessionId: captured.id,
              expectedVersion: 1,
              identity: { ...identity, key: "gr_override" }
            });
            const resumed = await repository.createCapturedSession(
              actor,
              input
            );
            expect(resumed.repositoryAssignment).toEqual(override);
            // Model the coordinated cutover; continued runtime capture cannot repair it.
            await pool.query(
              "update sessions set repository_assignment_state='historical_unresolved',repository_automatic_identity=null,repository_override_identity=null where id=$1",
              [captured.id]
            );
            const historical = await repository.createCapturedSession(
              actor,
              input
            );
            expect(historical.repositoryAssignment).toMatchObject({
              state: "historical_unresolved",
              effective: null
            });
            expect(historical.id).toBe(captured.id);
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        }
      );
    }
  );
});
