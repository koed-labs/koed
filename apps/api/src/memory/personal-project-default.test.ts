import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { personalProjectDefaultIdentity } from "@koed/shared/personal-project-default";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "@koed/db";
import {
  classifyPersonalInventory,
  personalFolderScopeId,
  personalInventoryConversationKey,
  repositoryScopeId,
  type PersonalFolderObservation,
  type RepositoryIdentity,
  type PersonalGitContext
} from "@koed/shared";
import { registerPersonalProjectRoutes } from "./personal-project-routes.js";
import { registerPersonalFolderRoutes } from "./personal-folder-routes.js";
import { registerPersonalSourceInventoryRoutes } from "./personal-source-inventory-routes.js";
import type { ApiRouteContext } from "../server/context.js";
import { loadPersonalInventory } from "../../../desktop/src/koed-server/personal-inventory.js";
import { PersonalMemoryStore } from "../../../desktop/src/renderer/state/personal-memory.js";
import {
  filterProjectSourceConversations,
  systemConversationViews,
  projectExecutionFolders
} from "../../../desktop/src/project-source-navigation.js";
import { createPersonalProjectDefaultService } from "../../../worker/src/personal-project-default-service.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("persistent source default Projects", () => {
  const databaseName = `project_defaults_${randomUUID().replaceAll("-", "")}`;
  const admin = createDbPool({
    connectionString: databaseUrl ?? "postgresql://localhost/postgres"
  });
  const url = new URL(databaseUrl ?? "postgresql://localhost/postgres");
  url.pathname = `/${databaseName}`;
  const pool = createDbPool({ connectionString: url.toString() });
  const repo = createMemorySourceRepository(pool);
  const git = (key = "gr_defaults"): PersonalGitContext => ({
    kind: "portable_repository",
    key,
    root: "/recorded/koed",
    branch: "main",
    checkoutId: "checkout_one",
    originatingDeviceId: "device_one",
    selectedRemote: "origin",
    anchorDisplay: "example.test/koed",
    reason: "origin"
  });
  const owner = async () => ({
    userId: (
      await repo.createUser({ email: `defaults-${randomUUID()}@example.test` })
    ).id
  });
  const capture = (actor: { userId: string }, repository = git()) =>
    repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: repository,
      metadata: { threadName: `Decision ${randomUUID()}` }
    });
  const drain = async (actor: { userId: string }, limit = 100) => {
    for (let i = 0; i < 100; i++) {
      if (!(await repo.reconcilePersonalProjectDefaults(actor, limit)).pending)
        return;
    }
    throw new Error("Default reconciliation did not finish");
  };
  const folder = (
    path: string,
    identity: Partial<PersonalFolderObservation["identity"]> = {}
  ): PersonalFolderObservation => ({
    identity: {
      folderId: randomUUID(),
      originatingDeploymentId: "deployment",
      originatingDeviceId: "device_one",
      originatingProfileId: "profile",
      directoryIncarnationId: randomUUID(),
      ...identity
    },
    normalizedPath: path,
    capturedPath: `${path}/.`,
    observedAt: new Date().toISOString()
  });
  const nonGit = (observed: PersonalFolderObservation): RepositoryIdentity => ({
    kind: "non_git_project",
    key: `ng_${observed.identity.folderId}`,
    root: observed.normalizedPath,
    branch: null,
    checkoutId: `checkout_${observed.identity.folderId}`,
    originatingDeviceId: observed.identity.originatingDeviceId,
    selectedRemote: null,
    anchorDisplay: null,
    reason: "non_git"
  });
  const captureFolder = (
    actor: { userId: string },
    observed: PersonalFolderObservation,
    repository: RepositoryIdentity | null = nonGit(observed)
  ) =>
    repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      folderObservation: observed,
      ...(repository ? { repositoryIdentity: repository } : {}),
      metadata: { threadName: `Folder decision ${randomUUID()}` }
    });
  const readInventory = async (actor: { userId: string }) => {
    const app = Fastify();
    const context = {
      requireRepository: () => repo,
      auth: { authenticate: async () => ({ id: actor.userId }) },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as unknown as ApiRouteContext;
    registerPersonalProjectRoutes(app, context);
    registerPersonalFolderRoutes(app, context);
    registerPersonalSourceInventoryRoutes(app, context);
    try {
      return await loadPersonalInventory(async (path) => {
        const result = await app.inject({ method: "GET", url: path });
        expect(result.statusCode, result.body).toBe(200);
        return result.json();
      });
    } finally {
      await app.close();
    }
  };
  beforeAll(async () => {
    await admin.query(`create database "${databaseName}"`);
    await runDbMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  });

  it("demonstrates two checkouts, later capture, rename, rule removal, restart, explicit inclusion and deletion through real API and Desktop inventories", async () => {
    const actor = await owner();
    await capture(actor);
    await capture(actor, {
      ...git(),
      root: "/other/checkout",
      checkoutId: "checkout_two",
      originatingDeviceId: "device_two"
    });
    await Promise.all([
      repo.reconcilePersonalProjectDefaults(actor),
      repo.reconcilePersonalProjectDefaults(actor)
    ]);
    let projects = await repo.listNamedPersonalProjects(actor);
    expect(projects).toHaveLength(1);
    const projectId = projects[0]!.projectId;
    expect(projectId).toBe(
      personalProjectDefaultIdentity({ kind: "repository", repository: git() })
        .projectIdentity
    );
    expect(projects[0]!.name).toBe("koed");
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as { statusCode?: number }).statusCode ?? 500)
        .send({ error: "Request failed" })
    );
    const context = {
      requireRepository: () => repo,
      auth: { authenticate: async () => ({ id: actor.userId }) },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as unknown as ApiRouteContext;
    registerPersonalProjectRoutes(app, context);
    registerPersonalFolderRoutes(app, context);
    registerPersonalSourceInventoryRoutes(app, context);
    const inventory = () =>
      loadPersonalInventory(async (path) => {
        const result = await app.inject({ method: "GET", url: path });
        expect(result.statusCode).toBe(200);
        return result.json();
      });
    try {
      expect(
        (await inventory()).projects.find(
          (p) => p.namedProject?.projectId === projectId
        )?.threads
      ).toHaveLength(2);
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/v1/personal/projects/${projectId}`,
            payload: {
              name: "Koed work",
              expectedVersion: projects[0]!.version
            }
          })
        ).statusCode
      ).toBe(200);
      await capture(actor, {
        ...git(),
        anchorDisplay: "example.test/new-label"
      });
      // A new repository instance resumes the same durable checkpoint.
      await createMemorySourceRepository(pool).reconcilePersonalProjectDefaults(
        actor
      );
      projects = await repo.listNamedPersonalProjects(actor);
      expect(projects[0]!.name).toBe("Koed work");
      expect(
        (await inventory()).projects.find(
          (p) => p.namedProject?.projectId === projectId
        )?.threads
      ).toHaveLength(3);
      const [rule] = await repo.listPersonalProjectRules(actor, projectId);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/personal/projects/${projectId}/rules/${rule!.inclusionId}`,
            payload: { expectedVersion: projects[0]!.version }
          })
        ).statusCode
      ).toBe(200);
      await capture(actor);
      await drain(actor);
      let named = (await inventory()).projects.find(
        (p) => p.namedProject?.projectId === projectId
      )!;
      expect(named.threads).toHaveLength(0);
      expect(named.inclusionRules).toHaveLength(0);
      expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(1);
      const decision = await pool.query(
        "select state from personal_project_defaults where owner_user_id=$1",
        [actor.userId]
      );
      expect(decision.rows).toEqual([{ state: "suppressed" }]);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/personal/projects/${projectId}/rules`,
            payload: {
              repository: git(),
              expectedVersion: named.namedProject!.version
            }
          })
        ).statusCode
      ).toBe(200);
      named = (await inventory()).projects.find(
        (p) => p.namedProject?.projectId === projectId
      )!;
      expect(named.threads).toHaveLength(4);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/v1/personal/projects/${projectId}`,
            payload: { expectedVersion: named.namedProject!.version }
          })
        ).statusCode
      ).toBe(200);
      await capture(actor);
      await drain(actor);
      expect(await repo.listNamedPersonalProjects(actor)).toEqual([]);
      const surviving = await inventory();
      expect(surviving.projects.flatMap((p) => p.threads)).toHaveLength(5);
    } finally {
      await app.close();
    }
  });
  it("records an existing rule as managed, keeps removal effective and leaves direct inclusions independent", async () => {
    const actor = await owner();
    const source = await capture(actor, git("gr_managed"));
    let manual = await repo.createNamedPersonalProject(actor, {
      name: "My grouping"
    });
    const included = await repo.addPersonalProjectRepositoryRule(
      actor,
      manual.projectId,
      { repository: git("gr_managed"), expectedVersion: manual.version }
    );
    manual = included.project;
    await drain(actor);
    expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(1);
    expect(
      (
        await pool.query(
          "select state from personal_project_defaults where owner_user_id=$1",
          [actor.userId]
        )
      ).rows
    ).toEqual([{ state: "managed" }]);
    await repo.removePersonalProjectRule(
      actor,
      manual.projectId,
      included.rule.inclusionId,
      { expectedVersion: manual.version }
    );
    await capture(actor, git("gr_managed"));
    await drain(actor);
    expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(1);
    const directSource = await capture(actor, git("gr_direct"));
    manual = (await repo.listNamedPersonalProjects(actor))[0]!;
    await repo.addPersonalProjectSession(actor, manual.projectId, {
      sessionId: directSource.id,
      expectedVersion: manual.version
    });
    await drain(actor);
    expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(2);
    expect(await repo.getCapturedSession(actor, source.id)).not.toBeNull();
    const other = await owner();
    await capture(other, git("gr_managed"));
    await drain(other);
    expect(await repo.listNamedPersonalProjects(other)).toHaveLength(1);
  });
  it("PV-05 applies mixed source drafts atomically and preserves overlap, exclusions, rename and explicit regrouping", async () => {
    const actor = await owner(),
      first = folder("/recorded/one"),
      second = folder("/recorded/two");
    const source = await captureFolder(actor, first, git("gr_group_one"));
    await captureFolder(actor, second, git("gr_group_two"));
    const context = (observed: PersonalFolderObservation) => ({
      ...observed.identity,
      ownerUserId: actor.userId
    });
    let project = await repo.createNamedPersonalProject(actor, {
      name: "Grouped work"
    });
    const projectId = project.projectId;
    const app = Fastify();
    registerPersonalProjectRoutes(app, {
      requireRepository: () => repo,
      auth: { authenticate: async () => ({ id: actor.userId }) },
      rateLimit: {
        memoryRead: async () => undefined,
        memoryWrite: async () => undefined
      }
    } as unknown as ApiRouteContext);
    const apply = (expectedVersion: number, changes: unknown[]) =>
      app.inject({
        method: "POST",
        url: `/v1/personal/projects/${projectId}/sources`,
        payload: { expectedVersion, changes }
      });
    try {
      const grouped = await apply(project.version, [
        { action: "add_folder", folder: context(first) },
        { action: "add_folder", folder: context(second) },
        { action: "add_repository", repository: git("gr_group_one") },
        { action: "add_repository", repository: git("gr_group_two") },
        { action: "add_session", sessionId: source.id }
      ]);
      expect(grouped.statusCode, grouped.body).toBe(200);
      project = grouped.json().project;
      expect(project.version).toBe(6);
      let inventory = await readInventory(actor);
      expect(
        inventory.projects.find((p) => p.id === projectId)?.threads
      ).toHaveLength(2);
      const explanation = await repo.explainPersonalProjectSession(
        actor,
        projectId,
        { sessionId: source.id, expectedVersion: project.version }
      );
      expect(
        explanation.explanation.reasons.map((reason) => reason.kind).sort()
      ).toEqual(["folder", "repository", "session"]);
      const rules = await repo.listPersonalProjectRules(actor, projectId);
      expect(rules).toHaveLength(4);
      const duplicate = await apply(project.version, [
        { action: "add_folder", folder: context(first) }
      ]);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json().project.version).toBe(project.version);
      expect(
        (
          await apply(1, [
            { action: "remove_rule", inclusionId: rules[0]!.inclusionId }
          ])
        ).statusCode
      ).toBe(409);
      const failed = await apply(project.version, [
        { action: "remove_rule", inclusionId: rules[0]!.inclusionId },
        {
          action: "add_folder",
          folder: { ...context(second), folderId: "unknown-folder" }
        }
      ]);
      expect(failed.statusCode, failed.body).toBe(404);
      expect(await repo.listPersonalProjectRules(actor, projectId)).toEqual(
        rules
      );
      expect((await repo.listNamedPersonalProjects(actor))[0]!.version).toBe(
        project.version
      );
      expect(
        (
          await pool.query(
            "select count(*)::int as count from personal_project_defaults where owner_user_id=$1",
            [actor.userId]
          )
        ).rows[0]!.count
      ).toBe(0);
      project = await repo.updateNamedPersonalProject(actor, projectId, {
        name: "Renamed grouping",
        expectedVersion: project.version
      });
      expect(project.projectId).toBe(projectId);
      expect(await repo.listPersonalProjectRules(actor, projectId)).toEqual(
        rules
      );
      const gitRule = rules.find(
        (rule) =>
          rule.target.kind === "repository" &&
          rule.target.repository.key === "gr_group_one"
      )!;
      project = (
        await apply(project.version, [
          { action: "remove_rule", inclusionId: gitRule.inclusionId }
        ])
      ).json().project;
      expect(
        (
          await repo.explainPersonalProjectSession(actor, projectId, {
            sessionId: source.id,
            expectedVersion: project.version
          })
        ).explanation.reasons
          .map((reason) => reason.kind)
          .sort()
      ).toEqual(["folder", "session"]);
      const excluded = await repo.excludePersonalProjectSession(
        actor,
        projectId,
        { sessionId: source.id, expectedVersion: project.version }
      );
      project = excluded.project;
      inventory = await readInventory(actor);
      expect(
        inventory.projects.find((p) => p.id === projectId)?.threads
      ).toHaveLength(1);
      const review = await repo.explainPersonalProjectSession(
        actor,
        projectId,
        { sessionId: source.id, expectedVersion: project.version }
      );
      expect(review.explanation.included).toBe(false);
      const exclusion = review.explanation.exclusion!;
      await expect(
        repo.restorePersonalProjectSession(actor, projectId, {
          sessionId: source.id,
          expectedVersion: project.version,
          exclusionId: exclusion.exclusionId,
          expectedExclusionRevisionId: randomUUID()
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      project = (
        await repo.restorePersonalProjectSession(actor, projectId, {
          sessionId: source.id,
          expectedVersion: project.version,
          exclusionId: exclusion.exclusionId,
          expectedExclusionRevisionId: exclusion.headRevisionId
        })
      ).project;
      const destination = await repo.createNamedPersonalProject(actor, {
        name: "Renamed grouping"
      });
      await repo.applyPersonalProjectSources(actor, destination.projectId, {
        expectedVersion: destination.version,
        changes: [{ action: "add_folder", folder: context(first) }]
      });
      const folderRule = rules.find(
        (rule) =>
          rule.target.kind === "folder" &&
          rule.target.folder.folderId === first.identity.folderId
      )!;
      project = (
        await apply(project.version, [
          { action: "remove_rule", inclusionId: folderRule.inclusionId }
        ])
      ).json().project;
      await captureFolder(actor, first, git("gr_group_one"));
      inventory = await readInventory(actor);
      expect(
        inventory.projects.find((p) => p.id === projectId)?.threads
      ).toHaveLength(2); // original direct inclusion and second Folder
      expect(
        inventory.projects.find((p) => p.id === destination.projectId)?.threads
      ).toHaveLength(2); // existing and future exact Folder matches
      expect(await repo.getCapturedSession(actor, source.id)).toMatchObject({
        id: source.id
      });
      expect(
        inventory.projects.filter(
          (p) => p.namedProject?.name === "Renamed grouping"
        )
      ).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("rolls back failed initialization, retains accepted capture and retries without a partial Project", async () => {
    const actor = await owner();
    const session = await capture(actor, git("gr_failure"));
    await pool.query(
      `create function fail_default_fixture() returns trigger language plpgsql as $$ begin if new.target->'repository'->>'key'='gr_failure' then raise exception 'fixture failure'; end if; return new; end $$`
    );
    await pool.query(
      "create trigger fail_default_fixture before insert on personal_project_rules for each row execute function fail_default_fixture()"
    );
    try {
      await expect(
        repo.reconcilePersonalProjectDefaults(actor)
      ).rejects.toThrow("fixture failure");
    } finally {
      await pool.query(
        "drop trigger fail_default_fixture on personal_project_rules"
      );
      await pool.query("drop function fail_default_fixture()");
    }
    expect(await repo.listNamedPersonalProjects(actor)).toEqual([]);
    expect(
      (
        await pool.query(
          "select 1 from personal_project_defaults where owner_user_id=$1",
          [actor.userId]
        )
      ).rowCount
    ).toBe(0);
    expect(await repo.getCapturedSession(actor, session.id)).not.toBeNull();
    await drain(actor, 1);
    expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(1);
  });
  it("removes default Project bookkeeping when its owner is hard-deleted", async () => {
    const actor = await owner();
    await pool.query(
      "insert into personal_project_default_reconciliation(owner_user_id) values($1) on conflict do nothing",
      [actor.userId]
    );
    await pool.query(
      `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state)
       values($1,'git:fixture','git:fixture','{}'::jsonb,'suppressed')`,
      [actor.userId]
    );
    await pool.query("delete from users where id=$1", [actor.userId]);
    for (const table of [
      "personal_project_default_reconciliation",
      "personal_project_defaults"
    ])
      expect(
        (
          await pool.query(`select 1 from ${table} where owner_user_id=$1`, [
            actor.userId
          ])
        ).rowCount
      ).toBe(0);
  });
  it("does not schedule retries for disabled or deleted owners", async () => {
    const retryAt = new Date("2001-02-03T04:05:06.000Z");
    const owners = [await owner(), await owner()];
    for (const actor of owners) await capture(actor, git(`gr_${randomUUID()}`));
    await pool.query(
      "update personal_project_default_reconciliation set pending=true,retry_at=$2 where owner_user_id=any($1::uuid[])",
      [owners.map((actor) => actor.userId), retryAt]
    );
    await pool.query("update users set disabled_at=now() where id=$1", [
      owners[0]!.userId
    ]);
    await pool.query("update users set deleted_at=now() where id=$1", [
      owners[1]!.userId
    ]);
    expect(await repo.nextPersonalProjectDefaultRetryAt()).not.toBe(
      retryAt.toISOString()
    );
    expect(owners.map((actor) => actor.userId)).not.toContain(
      await repo.nextPersonalProjectDefaultOwner()
    );
  });
  it("processes durable capture wakeups and resumes work accepted while the worker was stopped", async () => {
    const actor = await owner();
    const errors: unknown[] = [];
    const service = () =>
      createPersonalProjectDefaultService({
        repository: repo,
        wakePool: pool,
        logger: {
          error: (error) => {
            errors.push(error);
          }
        }
      });
    const first = service();
    await capture(actor, git("gr_wake_one"));
    first.start();
    try {
      await vi.waitFor(async () =>
        expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(1)
      );
      await capture(actor, git("gr_wake_two"));
      await vi.waitFor(async () =>
        expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(2)
      );
    } finally {
      await first.stop();
    }
    await capture(actor, git("gr_wake_three"));
    const restarted = service();
    restarted.start();
    try {
      await vi.waitFor(async () =>
        expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(3)
      );
    } finally {
      await restarted.stop();
    }
    expect(errors).toEqual([]);
  });
  it("classifies two checkouts, equal paths on other devices, replaced directories, parent/child Folders, mixed history and unresolved history", async () => {
    const actor = await owner();
    const first = folder("/checkout-one/koed"),
      second = folder("/checkout-two/koed", {
        originatingDeviceId: "device_two"
      });
    await captureFolder(actor, first, git("gr_folder_checkouts"));
    await captureFolder(actor, second, {
      ...git("gr_folder_checkouts"),
      root: second.normalizedPath,
      checkoutId: "checkout_two",
      originatingDeviceId: "device_two"
    });
    const notes = folder("/notes"),
      otherDevice = folder("/notes", {
        ...notes.identity,
        originatingDeviceId: "device_two"
      }),
      replacement = folder("/notes", {
        ...notes.identity,
        directoryIncarnationId: randomUUID()
      });
    const child = folder("/notes/drafts"),
      mixed = folder("/mixed"),
      unknown = folder("/unknown");
    const noteSource = await captureFolder(actor, notes);
    await captureFolder(actor, notes);
    await captureFolder(actor, otherDevice);
    await captureFolder(actor, replacement);
    await captureFolder(actor, child);
    await captureFolder(actor, mixed);
    await captureFolder(actor, mixed, git("gr_mixed"));
    await captureFolder(actor, mixed, null);
    await captureFolder(actor, unknown, null);
    const manual = await repo.createNamedPersonalProject(actor, {
      name: "notes"
    });
    const manualAgain = await repo.createNamedPersonalProject(actor, {
      name: "notes"
    });
    const authored = folder("/user-authored");
    await captureFolder(actor, authored);
    let authoredProject = (
      await repo.addPersonalProjectFolderRule(actor, manual.projectId, {
        expectedVersion: manual.version,
        folder: { ...authored.identity, ownerUserId: actor.userId }
      })
    ).project;
    authoredProject = (
      await repo.addPersonalProjectSession(actor, manual.projectId, {
        expectedVersion: authoredProject.version,
        sessionId: noteSource.id
      })
    ).project;
    authoredProject = (
      await repo.excludePersonalProjectSession(actor, manual.projectId, {
        expectedVersion: authoredProject.version,
        sessionId: noteSource.id
      })
    ).project;
    await drain(actor, 2);
    const inventory = await readInventory(actor),
      classification = classifyPersonalInventory(inventory.projects);
    const named = inventory.projects.filter((p) => p.namedProject);
    // Two Git defaults, five standalone/mixed defaults, and both manual Projects.
    expect(named).toHaveLength(9);
    expect(named.find((p) => p.id === manual.projectId)?.name).toBe("notes");
    const preserved = named.find((p) => p.id === manual.projectId)!;
    expect(preserved.namedProject?.version).toBe(authoredProject.version);
    expect(preserved.inclusionRules).toHaveLength(1);
    expect(preserved.directInclusions).toHaveLength(1);
    expect(preserved.threads).toHaveLength(1);
    expect(named.find((p) => p.id === manualAgain.projectId)?.name).toBe(
      "notes"
    );
    const exactKey = (observed: PersonalFolderObservation) =>
      personalFolderScopeId({
        ...observed.identity,
        ownerUserId: actor.userId
      });
    expect(
      classification.folders.find((entry) => entry.key === exactKey(first))
        ?.classification
    ).toBe("git_checkout");
    expect(
      classification.folders.find((entry) => entry.key === exactKey(second))
        ?.gitSources[0]?.key
    ).toBe(
      classification.folders.find((entry) => entry.key === exactKey(first))
        ?.gitSources[0]?.key
    );
    expect(
      classification.folders.find((entry) => entry.key === exactKey(mixed))
    ).toMatchObject({
      classification: "mixed",
      conversationCount: 3,
      standaloneConversationKeys: expect.any(Array),
      unresolvedConversationKeys: expect.any(Array)
    });
    expect(
      classification.folders.find((entry) => entry.key === exactKey(mixed))
        ?.standaloneConversationKeys
    ).toHaveLength(1);
    expect(
      classification.folders.find((entry) => entry.key === exactKey(mixed))
        ?.unresolvedConversationKeys
    ).toHaveLength(1);
    expect(
      classification.folders.find((entry) => entry.key === exactKey(unknown))
        ?.classification
    ).toBe("unresolved");
    expect(
      classification.equalLabels.find((entry) => entry.label === "notes")
        ?.selections.length
    ).toBeGreaterThan(3);
    expect(classification.overlappingViews.length).toBeGreaterThan(0);
    const noteProject = named.find((p) =>
      p.inclusionRules?.some(
        (rule) =>
          rule.target.kind === "folder" &&
          personalFolderScopeId(rule.target.folder) === exactKey(notes)
      )
    )!;
    const childProject = named.find((p) =>
      p.inclusionRules?.some(
        (rule) =>
          rule.target.kind === "folder" &&
          personalFolderScopeId(rule.target.folder) === exactKey(child)
      )
    )!;
    expect(noteProject.threads).toHaveLength(2);
    expect(childProject.threads).toHaveLength(1);
    const [seed] = noteProject.inclusionRules!;
    await repo.removePersonalProjectRule(
      actor,
      noteProject.id,
      seed!.inclusionId,
      { expectedVersion: noteProject.namedProject!.version }
    );
    await captureFolder(actor, notes);
    await drain(actor);
    expect(
      (await readInventory(actor)).projects.find((p) => p.id === noteProject.id)
        ?.threads
    ).toHaveLength(0);
    expect(await repo.listNamedPersonalProjects(actor)).toHaveLength(9);
  });
  it("retires only untouched and fully covered Folder defaults, while retaining rename and protected sharing intent", async () => {
    for (const intent of ["untouched", "renamed", "sharing"] as const) {
      const actor = await owner(),
        observed = folder(`/retire/${intent}`),
        source = await captureFolder(actor, observed);
      await drain(actor);
      const old = (await repo.listNamedPersonalProjects(actor))[0]!;
      if (intent === "renamed")
        await repo.updateNamedPersonalProject(actor, old.projectId, {
          name: "Keep my grouping",
          expectedVersion: old.version
        });
      if (intent === "sharing") {
        const enrollment = await pool.query<{ id: string }>(
          `insert into collaboration_shared_memory_enrollments(backend_id,local_owner_user_id,upstream_user_id,remote_device_id) values($1,$2,$3,$4) returning id`,
          [`backend_${randomUUID()}`, actor.userId, randomUUID(), randomUUID()]
        );
        await pool.query(
          `insert into collaboration_sharing_rule_deliveries(enrollment_id,mutation_id,rule_id,logical_grant_id,intent_hash,state) values($1,$2,$3,$4,$5,'needs_review')`,
          [
            enrollment.rows[0]!.id,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "a".repeat(64)
          ]
        );
      }
      const target = git(`gr_retire_${intent}`);
      await capture(actor, target);
      await drain(actor);
      const review = await repo.previewPersonalSourceCorrection(
        actor,
        source.id,
        { axis: "git", action: "set", repository: target, expectedVersion: 1 }
      );
      await repo.applyPersonalSourceCorrection(
        actor,
        source.id,
        review.preview.reviewId,
        { expectedVersion: 1 }
      );
      await drain(actor);
      const remaining = await repo.listNamedPersonalProjects(actor);
      expect(
        remaining.some((project) => project.projectId === old.projectId)
      ).toBe(intent !== "untouched");
      const decision = await pool.query<{ state: string }>(
        "select state from personal_project_defaults where owner_user_id=$1 and project_id=$2",
        [actor.userId, old.projectId]
      );
      expect(decision.rows[0]!.state).toBe(
        intent === "untouched" ? "retired" : "initialized"
      );
      expect(await repo.getCapturedSession(actor, source.id)).not.toBeNull();
    }
  });
  it("PV-07 reconciles and browses 601 existing Conversations through the final Project/source boundary without losing mixed history", async () => {
    const actor = await owner(),
      left = folder("/existing/koed"),
      right = folder("/existing/koed-alt"),
      notes = folder("/existing/notes");
    const main = git("gr_pv07_koed"),
      rightGit = {
        ...main,
        root: "/existing/koed-alt",
        checkoutId: "other_checkout"
      },
      other = {
        ...main,
        key: "gr_pv07_research",
        anchorDisplay: "example.test/research"
      };
    const first = await captureFolder(actor, left, main),
      second = await captureFolder(actor, right, rightGit);
    await captureFolder(actor, notes);
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      metadata: { threadName: "Unresolved existing history" }
    });
    await pool.query(
      `insert into sessions(owner_user_id,source_runtime,capture_method,external_session_id,metadata,repository_assignment_state,repository_automatic_identity,folder_assignment)
      select $1,'codex','transcript','reused-provider-thread',jsonb_build_object('threadName','Existing '||n::text),'recorded',
        case when n=597 then $4::jsonb when n%2=0 then $2::jsonb else $3::jsonb end,
        case when n=597 or n%2=0 then a.folder_assignment else b.folder_assignment end
      from generate_series(1,597) n cross join sessions a cross join sessions b where a.id=$5 and b.id=$6`,
      [
        actor.userId,
        JSON.stringify(main),
        JSON.stringify(rightGit),
        JSON.stringify(other),
        first.id,
        second.id
      ]
    );
    const manual = await repo.createNamedPersonalProject(actor, {
      name: "koed"
    });
    await repo.addPersonalProjectSession(actor, manual.projectId, {
      sessionId: first.id,
      expectedVersion: manual.version
    });
    await drain(actor, 37);
    const mainId = personalProjectDefaultIdentity({
      kind: "repository",
      repository: main
    }).projectIdentity;
    const otherId = personalProjectDefaultIdentity({
      kind: "repository",
      repository: other
    }).projectIdentity;
    const readState = async () => {
      const data = await readInventory(actor);
      const store = new PersonalMemoryStore({
        listProjects: async () => data.projects,
        loadEventPage: async () => [],
        subscribe: () => () => undefined,
        updateSessionTitle: async ({ title }) => ({ title }),
        updateSessionPresentation: async () => {
          throw new Error("Read-only fixture");
        },
        projectStatus: () => repo.personalProjectDefaultStatus(actor)
      });
      await store.loadProjects();
      return store.current();
    };
    let state = await readState();
    expect(state.inventory.projects).toHaveLength(4);
    expect(
      state.inventory.projects.filter((project) => project.name === "koed")
    ).toHaveLength(2);
    expect(state.inventory.gitSources).toHaveLength(2);
    expect(state.inventory.folders).toHaveLength(3);
    const sqlIds = (
      await pool.query<{ id: string }>(
        "select id from sessions where owner_user_id=$1",
        [actor.userId]
      )
    ).rows.map((row) => row.id);
    expect(sqlIds).toHaveLength(601);
    const reachable = new Set(
      [
        ...state.inventory.projects.flatMap((project) => project.threads),
        ...systemConversationViews(state.inventory).available
      ].map((thread) => thread.sessionId)
    );
    expect(reachable).toEqual(new Set(sqlIds));
    expect(systemConversationViews(state.inventory).unresolved).toHaveLength(1);
    expect(
      state.inventory.classification.folders.filter(
        (item) => item.classification === "git_checkout"
      )
    ).toHaveLength(2);
    expect(
      state.inventory.classification.folders.filter(
        (item) => item.classification === "standalone"
      )
    ).toHaveLength(1);
    expect(
      state.inventory.classification.equalLabels.some(
        (item) => item.label === "koed"
      )
    ).toBe(true);
    let project = state.inventory.projects.find(
      (project) => project.id === mainId
    )!;
    expect(project.threads).toHaveLength(598);
    expect(projectExecutionFolders(project, state.inventory)).toEqual([]);
    let current = (
      await repo.excludePersonalProjectSession(actor, mainId, {
        sessionId: first.id,
        expectedVersion: project.namedProject!.version
      })
    ).project;
    current = (
      await repo.applyPersonalProjectSources(actor, mainId, {
        expectedVersion: current.version,
        changes: [{ action: "add_repository", repository: other }]
      })
    ).project;
    state = await readState();
    project = state.inventory.projects.find(
      (project) => project.id === mainId
    )!;
    expect(project.threads).toHaveLength(598);
    const leftFilter = {
      kind: "folder" as const,
      key: personalFolderScopeId({
        ...left.identity,
        ownerUserId: actor.userId
      })
    };
    const folderMembers = filterProjectSourceConversations(
      project,
      leftFilter,
      state.inventory
    );
    const nested = filterProjectSourceConversations(
      project,
      { ...leftFilter, gitKey: repositoryScopeId(main) },
      state.inventory
    );
    expect(folderMembers).toHaveLength(299);
    expect(nested).toHaveLength(298);
    expect(nested.some((thread) => thread.sessionId === first.id)).toBe(false);
    await repo.updateNamedPersonalProject(actor, mainId, {
      name: "Koed retained work",
      expectedVersion: current.version
    });
    await captureFolder(actor, left, main);
    await drain(actor, 37);
    state = await readState();
    project = state.inventory.projects.find(
      (project) => project.id === mainId
    )!;
    expect(project.name).toBe("Koed retained work");
    expect(project.threads).toHaveLength(599);
    const otherRule = project.inclusionRules!.find(
      (rule) =>
        rule.target.kind === "repository" &&
        rule.target.repository.key === other.key
    )!;
    await repo.applyPersonalProjectSources(actor, mainId, {
      expectedVersion: project.namedProject!.version,
      changes: [{ action: "remove_rule", inclusionId: otherRule.inclusionId }]
    });
    const otherProject = (await repo.listNamedPersonalProjects(actor)).find(
      (project) => project.projectId === otherId
    )!;
    await repo.deleteNamedPersonalProject(actor, otherId, {
      expectedVersion: otherProject.version
    });
    await captureFolder(actor, left, other);
    const restarted = createMemorySourceRepository(pool);
    while (
      (await restarted.reconcilePersonalProjectDefaults(actor, 37)).pending
    ) {
      /* Drain durable bounded work. */
    }
    state = await readState();
    expect(
      state.inventory.projects.find((project) => project.id === mainId)?.threads
    ).toHaveLength(598);
    expect(
      state.inventory.projects.some((project) => project.id === otherId)
    ).toBe(false);
    const research = state.inventory.gitSources.find(
      (source) => source.id === repositoryScopeId(other)
    )!;
    expect(research.threads).toHaveLength(2);
    const allReachable = new Set(
      [
        ...state.inventory.projects.flatMap((project) => project.threads),
        ...systemConversationViews(state.inventory).available
      ].map(personalInventoryConversationKey)
    );
    expect(allReachable.size).toBe(603);
    expect(systemConversationViews(state.inventory).available).toHaveLength(3);
    expect(await repo.getCapturedSession(actor, first.id)).not.toBeNull();
    const report = {
      initialConversations: 601,
      finalConversations: allReachable.size,
      finalProjects: state.inventory.projects.length,
      gitSources: state.inventory.gitSources.length,
      folders: state.inventory.folders.length,
      equalIdentityViews: state.inventory.classification.equalIdentities.length,
      equalLabels: state.inventory.classification.equalLabels.length,
      overlappingConversations:
        state.inventory.classification.overlappingViews.length,
      unresolvedConversations: systemConversationViews(state.inventory)
        .unresolved.length,
      availableWithoutProject: systemConversationViews(state.inventory)
        .available.length
    };
    const reportDirectory = resolve(
      import.meta.dirname,
      "../../../../scratch/pv-07"
    );
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(
      resolve(reportDirectory, "existing-data-classification.json"),
      JSON.stringify(report, null, 2)
    );
    console.log("PV-07 existing-data classification", JSON.stringify(report));
  }, 30_000);
});
