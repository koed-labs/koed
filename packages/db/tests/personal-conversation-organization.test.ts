import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalConversationOrganizationInput,
  type PersonalFolderObservation,
  type PersonalGitContext,
  type PersonalSelectionSnapshot
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const options = {
  envelopeEncryptionProvider: createLocalTestKeyEnvelopeEncryptionProvider(
    Buffer.alloc(32, 95).toString("base64")
  )
};
const git: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_organization",
  root: "/repo",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/organization"
};

describe.skipIf(!databaseUrl)(
  "atomic Conversation organization in PostgreSQL",
  () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = createDbPool({ connectionString: databaseUrl });
      await runDbMigrations(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });
    async function fixture() {
      const repo = createMemorySourceRepository(pool, options);
      const actor = {
        userId: (
          await repo.createUser({
            email: `organization-${randomUUID()}@example.test`
          })
        ).id
      };
      const folder: PersonalFolderObservation = {
        identity: {
          folderId: randomUUID(),
          originatingDeploymentId: "deployment",
          originatingDeviceId: "device",
          originatingProfileId: "profile",
          directoryIncarnationId: randomUUID()
        },
        normalizedPath: "/repo",
        capturedPath: "/repo",
        observedAt: new Date().toISOString()
      };
      const source = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: git,
        folderObservation: folder
      });
      await repo.createMemoryEvent(actor, {
        projectId: "legacy",
        sessionId: source.id,
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        rawEventType: "user_message",
        content: "ORGANIZATION_DECISION",
        idempotencyKey: randomUUID()
      });
      let a = await repo.createNamedPersonalProject(actor, {
        name: "Folder A"
      });
      a = (
        await repo.addPersonalProjectFolderRule(actor, a.projectId, {
          expectedVersion: a.version,
          folder: { ...folder.identity, ownerUserId: actor.userId }
        })
      ).project;
      let b = await repo.createNamedPersonalProject(actor, {
        name: "Git Anchor X"
      });
      b = (
        await repo.addPersonalProjectRepositoryRule(actor, b.projectId, {
          expectedVersion: b.version,
          repository: git
        })
      ).project;
      const c = await repo.createNamedPersonalProject(actor, {
        name: "Manual C"
      });
      let d = await repo.createNamedPersonalProject(actor, {
        name: "Other manual membership"
      });
      d = (
        await repo.addPersonalProjectSession(actor, d.projectId, {
          expectedVersion: d.version,
          sessionId: source.id
        })
      ).project;
      const context = (await repo.getPersonalSourceContext(actor, source.id))
        .context;
      const edit: PersonalConversationOrganizationInput = {
        expectedContext: context,
        reviewedProjects: [a, b, c, d].map((p) => ({
          projectId: p.projectId,
          expectedVersion: p.version
        })),
        memberships: [
          { projectId: a.projectId, direct: false, excluded: true },
          { projectId: c.projectId, direct: true, excluded: false }
        ],
        corrections: []
      };
      const accessible = async (
        target: Extract<PersonalSelectionSnapshot, { version: 1 }>["target"]
      ) =>
        !!(await repo.getCapturedSession(actor, source.id, {
          personalSelection: {
            version: 1,
            ownerUserId: actor.userId,
            target,
            callerRepositoryContext: null
          }
        }));
      return {
        repo,
        actor,
        source,
        folder,
        a,
        b,
        c,
        d,
        context,
        edit,
        accessible
      };
    }

    it("moves only the source membership while retaining independent Folder and Git recall", async () => {
      const f = await fixture();
      const result = await f.repo.organizePersonalConversation(
        f.actor,
        f.source.id,
        f.edit
      );
      expect(result.context).toEqual(f.context);
      const states = result.organization.after.projects;
      expect(
        states.find((p) => p.project.projectId === f.a.projectId)?.explanation
      ).toMatchObject({ included: false, exclusion: { clearedAt: null } });
      for (const p of [f.b, f.c, f.d])
        expect(
          states.find((row) => row.project.projectId === p.projectId)
            ?.explanation.included
        ).toBe(true);
      expect(
        await f.accessible({
          kind: "folder",
          folder: { ...f.folder.identity, ownerUserId: f.actor.userId }
        })
      ).toBe(true);
      expect(await f.accessible({ kind: "repository", repository: git })).toBe(
        true
      );
      expect(
        await f.accessible({
          kind: "project",
          project: { ownerUserId: f.actor.userId, projectId: f.a.projectId }
        })
      ).toBe(false);
      expect(
        await f.accessible({
          kind: "project",
          project: { ownerUserId: f.actor.userId, projectId: f.c.projectId }
        })
      ).toBe(true);
    });

    it("clears both source tags atomically, retains originals and direct memberships, and can restore both axes", async () => {
      const f = await fixture();
      f.edit.corrections = ["git", "folder"].map((axis) => ({
        axis: axis as "git" | "folder",
        action: "unresolved",
        expectedVersion: 1
      }));
      const result = await f.repo.organizePersonalConversation(
        f.actor,
        f.source.id,
        f.edit
      );
      for (const axis of ["git", "folder"] as const) {
        expect(result.context[axis].original).toEqual(f.context[axis].original);
        expect(result.context[axis].correction).toMatchObject({
          state: "corrected",
          value: { state: "unresolved" }
        });
      }
      expect(
        result.organization.after.projects.find(
          (p) => p.project.projectId === f.b.projectId
        )?.explanation.included
      ).toBe(false);
      for (const p of [f.c, f.d])
        expect(
          result.organization.after.projects.find(
            (row) => row.project.projectId === p.projectId
          )?.explanation.included
        ).toBe(true);
      const restored = await f.repo.organizePersonalConversation(
        f.actor,
        f.source.id,
        {
          expectedContext: result.context,
          reviewedProjects: result.organization.after.projects.map((p) => ({
            projectId: p.project.projectId,
            expectedVersion: p.project.version
          })),
          memberships: [],
          corrections: ["git", "folder"].map((axis) => ({
            axis: axis as "git" | "folder",
            action: "reset",
            expectedVersion: 2
          }))
        }
      );
      expect(restored.context.git.correction.state).toBe("original");
      expect(restored.context.folder.correction.state).toBe("original");
      expect(
        restored.organization.after.projects.find(
          (p) => p.project.projectId === f.a.projectId
        )?.explanation.included
      ).toBe(false);
      expect(
        restored.organization.after.projects.find(
          (p) => p.project.projectId === f.b.projectId
        )?.explanation.included
      ).toBe(true);
    });

    it("rolls source corrections and the source exclusion back when destination restoration fails", async () => {
      const f = await fixture();
      const blocked = await f.repo.excludePersonalProjectSession(
        f.actor,
        f.c.projectId,
        { sessionId: f.source.id, expectedVersion: f.c.version }
      );
      f.edit.reviewedProjects.find(
        (p) => p.projectId === f.c.projectId
      )!.expectedVersion = blocked.project.version;
      f.edit.memberships[1]!.restoreExclusion = {
        exclusionId: blocked.explanation.exclusion!.exclusionId,
        expectedExclusionRevisionId: randomUUID()
      };
      f.edit.corrections = [
        { axis: "folder", action: "unresolved", expectedVersion: 1 }
      ];
      await expect(
        f.repo.organizePersonalConversation(f.actor, f.source.id, f.edit)
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await f.repo.getPersonalSourceContext(f.actor, f.source.id)).context
      ).toEqual(f.context);
      expect(
        (
          await f.repo.explainPersonalProjectSession(f.actor, f.a.projectId, {
            sessionId: f.source.id,
            expectedVersion: f.a.version
          })
        ).explanation.included
      ).toBe(true);
      f.edit.memberships[1]!.restoreExclusion!.expectedExclusionRevisionId =
        blocked.explanation.exclusion!.headRevisionId;
      const moved = await f.repo.organizePersonalConversation(
        f.actor,
        f.source.id,
        f.edit
      );
      expect(
        moved.organization.after.projects.find(
          (p) => p.project.projectId === f.c.projectId
        )?.explanation
      ).toMatchObject({ included: true });
    });

    it("rejects stale context, a changed Project catalog, and another owner's source", async () => {
      const f = await fixture();
      await f.repo.createNamedPersonalProject(f.actor, {
        name: "Added after review"
      });
      f.edit.corrections = [
        { axis: "git", action: "unresolved", expectedVersion: 1 }
      ];
      await expect(
        f.repo.organizePersonalConversation(f.actor, f.source.id, f.edit)
      ).rejects.toMatchObject({ statusCode: 409 });
      const other = {
        userId: (
          await f.repo.createUser({
            email: `other-${randomUUID()}@example.test`
          })
        ).id
      };
      await expect(
        f.repo.organizePersonalConversation(other, f.source.id, f.edit)
      ).rejects.toMatchObject({ statusCode: 404 });
      f.edit.corrections = [];
      f.edit.expectedContext = {
        ...f.context,
        git: { ...f.context.git, revision: 2 }
      };
      await expect(
        f.repo.organizePersonalConversation(f.actor, f.source.id, f.edit)
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        (await f.repo.getPersonalSourceContext(f.actor, f.source.id)).context
      ).toEqual(f.context);
    });

    it("saves a rename and reviewed exclusion restore as one Project settings draft", async () => {
      const f = await fixture();
      const blocked = await f.repo.excludePersonalProjectSession(
        f.actor,
        f.c.projectId,
        { sessionId: f.source.id, expectedVersion: f.c.version }
      );
      const restore = {
        action: "add_back" as const,
        sessionId: f.source.id,
        exclusionId: blocked.explanation.exclusion!.exclusionId,
        expectedExclusionRevisionId:
          blocked.explanation.exclusion!.headRevisionId
      };
      await expect(
        f.repo.applyPersonalProjectSources(f.actor, f.c.projectId, {
          expectedVersion: blocked.project.version,
          changes: [
            { action: "rename", name: "Must roll back" },
            { ...restore, expectedExclusionRevisionId: randomUUID() }
          ]
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      const unchanged = await f.repo.explainPersonalProjectSession(
        f.actor,
        f.c.projectId,
        { sessionId: f.source.id, expectedVersion: blocked.project.version }
      );
      expect(unchanged.project.name).toBe(f.c.name);
      expect(unchanged.explanation.included).toBe(false);
      const result = await f.repo.applyPersonalProjectSources(
        f.actor,
        f.c.projectId,
        {
          expectedVersion: blocked.project.version,
          changes: [{ action: "rename", name: "Reviewed Project" }, restore]
        }
      );
      expect(result.project.name).toBe("Reviewed Project");
      expect(
        (
          await f.repo.explainPersonalProjectSession(f.actor, f.c.projectId, {
            sessionId: f.source.id,
            expectedVersion: result.project.version
          })
        ).explanation.included
      ).toBe(true);
    });
  }
);
