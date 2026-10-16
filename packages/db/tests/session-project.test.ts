import { randomUUID } from "node:crypto";
import { expect, it, describe, beforeAll, afterAll } from "vitest";
import {
  repositoryScopeId,
  createPdsRepositoryAssignment,
  type RepositoryIdentity
} from "@koed/shared";
import { projectFromRepositoryIdentity } from "../src/session-project.js";
import { applyPdsRepositoryAssignmentSnapshot } from "../src/pds-repository-assignment.js";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository
} from "../src/index.js";
const identity = (key: string): RepositoryIdentity => ({
  kind: "portable_repository",
  key: `gr_${key}`,
  root: `/checkout/${key}`,
  branch: "main",
  reason: "origin",
  checkoutId: `checkout_${key}`,
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: `example.test/team/${key}`
});
it("derives current identity and path without accepting stale override hints", () => {
  const a = identity("a"),
    b = identity("b");
  const old = { id: repositoryScopeId(a), name: "Old label", path: "/stale" };
  expect(projectFromRepositoryIdentity(b, a, old, old)).toEqual({
    id: repositoryScopeId(b),
    name: b.anchorDisplay,
    path: b.root
  });
  expect(projectFromRepositoryIdentity(null, a, old, old)).toBeNull();
  const named: RepositoryIdentity = {
    kind: "local_project",
    key: "project_named",
    reason: "manual",
    root: null,
    branch: null,
    checkoutId: null,
    originatingDeviceId: "device",
    selectedRemote: null,
    anchorDisplay: null
  };
  expect(
    projectFromRepositoryIdentity(named, a, old, {
      id: repositoryScopeId(named),
      name: "Planning",
      path: "/stale"
    })
  ).toEqual({ id: repositoryScopeId(named), name: "Planning", path: null });
});
const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("replicated effective Project projection", () => {
  const pool = createDbPool({ connectionString: databaseUrl });
  beforeAll(() => runDbMigrations(pool), 60000);
  afterAll(() => pool.end());
  it("returns the same reassigned Project from Session APIs and graph views after a PDS update", async () => {
    const repo = createMemorySourceRepository(pool);
    const user = await repo.createUser({
      email: `project-projection-${randomUUID()}@example.test`
    });
    const actor = { userId: user.id };
    const a = identity("a"),
      b = identity("b");
    const original = {
      state: "recorded" as const,
      version: 1,
      automatic: a,
      override: null,
      effective: a
    };
    const key = Buffer.alloc(32, 1).toString("base64url");
    const previous = createPdsRepositoryAssignment(original, "1", key);
    const session = await repo.createCapturedSession(actor, {
      sourceRuntime: "codex",
      externalSessionId: randomUUID(),
      replicatedRepositoryAssignment: original,
      cwd: "/checkout/a",
      detectedProjects: [
        { id: "legacy-project", name: "Original", path: "/checkout/a" }
      ],
      metadata: {
        threadName: "Synced Conversation",
        pds: { repositoryAssignment: previous }
      }
    });
    const incoming = createPdsRepositoryAssignment(
      { ...original, version: 2, override: b, effective: b },
      "1",
      key
    );
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(
        await applyPdsRepositoryAssignmentSnapshot(
          client,
          user.id,
          session.id,
          incoming
        )
      ).toBe(true);
      await client.query("commit");
    } finally {
      client.release();
    }
    const updated = await repo.getCapturedSession(actor, session.id);
    expect(updated?.project).toEqual({
      id: repositoryScopeId(b),
      name: b.anchorDisplay,
      path: b.root
    });
    expect(updated?.projectAssignmentSource).toBe("user_override");
    const projects = await repo.listLcmGraphThreads(actor, {
      projectId: repositoryScopeId(b)
    });
    const project = projects.find(
      (project) => project.id === repositoryScopeId(b)
    );
    expect(project).toMatchObject({
      id: repositoryScopeId(b),
      name: b.anchorDisplay,
      path: b.root
    });
    expect(
      project?.threads.find((thread) => thread.sessionId === session.id)
    ).toMatchObject({
      projectId: repositoryScopeId(b),
      projectName: b.anchorDisplay,
      projectPath: b.root,
      projectAssignmentSource: "user_override"
    });
  });
});
