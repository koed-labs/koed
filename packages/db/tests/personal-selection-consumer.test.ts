import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createPersonalSelectionConsumerRepository } from "../src/personal-selection-consumer-repository.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  createLocalTestKeyEnvelopeEncryptionProvider,
  type PersonalGitContext,
  type PersonalFolderObservation
} from "@koed/shared";
import {
  createDbPool,
  createMemorySourceRepository,
  runDbMigrations
} from "../src/index.js";
const databaseUrl = process.env.P1_SELECTION_CONSUMER_DATABASE_URL;
const encryption = createLocalTestKeyEnvelopeEncryptionProvider(
  Buffer.alloc(32, 122).toString("base64")
);
describe.skipIf(!databaseUrl)("Bounded Personal selection consumer", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createDbPool({ connectionString: databaseUrl });
    await runDbMigrations(pool);
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
  });
  afterEach(() => vi.restoreAllMocks());
  const user = async () => ({
    userId: (
      await createMemorySourceRepository(pool).createUser({
        email: `consumer-${randomUUID()}@example.test`
      })
    ).id
  });
  it("requires conclusive owner-bound evidence before removing a known Git Anchor member", async () => {
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const actor = await user(),
      other = await user();
    const git: PersonalGitContext = {
      kind: "portable_repository",
      key: `gr_${randomUUID()}`,
      root: "/private/member-evaluation",
      branch: "main",
      reason: "origin",
      checkoutId: "member-checkout",
      originatingDeviceId: "member-device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/members"
    };
    const sessions = [];
    for (let i = 0; i < 6; i++)
      sessions.push(
        await repo.createCapturedSession(i === 5 ? other : actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity:
            i === 1 ? { ...git, key: `gr_${randomUUID()}` } : git
        })
      );
    await pool.query("update sessions set invalidated_at=now() where id=$1", [
      sessions[2]!.id
    ]);
    await pool.query(
      "update sessions set personal_deleted_at=now() where id=$1",
      [sessions[3]!.id]
    );
    await pool.query(
      "update sessions set repository_automatic_identity=null,repository_override_identity=null where id=$1",
      [sessions[4]!.id]
    );
    const identities = await pool.query<{
      id: string;
      logical_session_id: string;
    }>("select id,logical_session_id from sessions where id=any($1::uuid[])", [
      sessions.map((session) => session.id)
    ]);
    const byId = new Map(
      identities.rows.map((row) => [row.id, row.logical_session_id])
    );
    const sources = sessions.map((session) => ({
      localSessionId: session.id,
      localLogicalSessionId: byId.get(session.id)!
    }));
    const baseline = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "repository", repository: git }
    });
    const input = { cursor: baseline.changeCursor!, sources };
    const evaluation = await repo.evaluatePersonalSelectionMembers(
      actor,
      input
    );
    expect(evaluation.entries.map((entry) => entry.state)).toEqual([
      "matching",
      "not_matching",
      "unresolved",
      "deleted",
      "unresolved",
      "unresolved"
    ]);
    expect(evaluation.snapshotVersion).toBe(baseline.snapshotVersion);
    expect(
      evaluation.entries
        .filter((entry) => entry.state === "unresolved")
        .every(
          (entry) =>
            entry.sourceContextHash === null && entry.contextVersion === null
        )
    ).toBe(true);
    expect(JSON.stringify(evaluation)).not.toContain(git.root);
    await expect(
      repo.evaluatePersonalSelectionMembers(other, input)
    ).rejects.toMatchObject({ statusCode: 404 });
    const wrongIdentity = await repo.evaluatePersonalSelectionMembers(actor, {
      ...input,
      sources: [{ ...sources[0]!, localLogicalSessionId: randomUUID() }]
    });
    expect(wrongIdentity.entries[0]!.state).toBe("unresolved");
    await pool.query(
      "update sessions set repository_assignment_version=repository_assignment_version+1 where id=$1",
      [sessions[0]!.id]
    );
    await expect(
      repo.evaluatePersonalSelectionMembers(actor, input)
    ).rejects.toMatchObject({ code: "selection_enumeration_stale" });
  });
  it("evaluates exact Folder membership without using path equality or Git context", async () => {
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const actor = await user();
    const folder: PersonalFolderObservation = {
      identity: {
        folderId: randomUUID(),
        originatingDeploymentId: "folder-proof-deployment",
        originatingDeviceId: "folder-proof-device",
        originatingProfileId: "folder-proof-profile",
        directoryIncarnationId: randomUUID()
      },
      normalizedPath: "/private/folder-proof/exact",
      capturedPath: "/private/folder-proof/exact",
      observedAt: new Date().toISOString()
    };
    const distinct = (
      path: string,
      device = folder.identity.originatingDeviceId
    ): PersonalFolderObservation => ({
      ...folder,
      identity: {
        ...folder.identity,
        folderId: randomUUID(),
        originatingDeviceId: device,
        directoryIncarnationId: randomUUID()
      },
      normalizedPath: path,
      capturedPath: path
    });
    const observations = [
      folder,
      distinct(`${folder.normalizedPath}/child`),
      distinct("/private/folder-proof"),
      distinct(folder.normalizedPath, "another-device"),
      {
        ...folder,
        identity: { ...folder.identity, directoryIncarnationId: randomUUID() }
      },
      undefined,
      folder,
      folder
    ];
    const sessions = [];
    for (const folderObservation of observations)
      sessions.push(
        await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          folderObservation
        })
      );
    await pool.query("update sessions set invalidated_at=now() where id=$1", [
      sessions[6]!.id
    ]);
    await pool.query(
      "update sessions set personal_deleted_at=now() where id=$1",
      [sessions[7]!.id]
    );
    const sources = await pool.query<{
      id: string;
      logical_session_id: string;
    }>("select id,logical_session_id from sessions where id=any($1::uuid[])", [
      sessions.map((session) => session.id)
    ]);
    const identities = new Map(
      sources.rows.map((row) => [row.id, row.logical_session_id])
    );
    const baseline = await repo.startPersonalSelectionEnumeration(actor, {
      target: {
        kind: "folder",
        folder: { ownerUserId: actor.userId, ...folder.identity }
      }
    });
    expect(
      baseline.entries.map((entry) => entry.source.localSessionId)
    ).toEqual([sessions[0]!.id]);
    const evaluation = await repo.evaluatePersonalSelectionMembers(actor, {
      cursor: baseline.changeCursor!,
      sources: sessions.map((session) => ({
        localSessionId: session.id,
        localLogicalSessionId: identities.get(session.id)!
      }))
    });
    expect(evaluation.entries.map((entry) => entry.state)).toEqual([
      "matching",
      "not_matching",
      "not_matching",
      "not_matching",
      "not_matching",
      "unresolved",
      "unresolved",
      "deleted"
    ]);
    expect(
      evaluation.entries
        .filter((entry) => entry.state !== "unresolved")
        .every(
          (entry) =>
            entry.contextVersion?.git === 1 &&
            entry.contextVersion.folder === 1 &&
            entry.sourceContextHash !== null
        )
    ).toBe(true);
    expect(JSON.stringify(evaluation)).not.toContain(folder.normalizedPath);
    expect(JSON.stringify(evaluation)).not.toContain(
      folder.identity.originatingDeviceId
    );
  });
  it("retains Project membership across overlapping inclusions and separates exclusion, unknown context and deletion", async () => {
    const repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const actor = await user();
    const git: PersonalGitContext = {
      kind: "portable_repository",
      key: `gr_${randomUUID()}`,
      root: "/private/project-proof",
      branch: "main",
      reason: "origin",
      checkoutId: "checkout",
      originatingDeviceId: "device",
      selectedRemote: "origin",
      anchorDisplay: "Private repository"
    };
    const folder: PersonalFolderObservation = {
      identity: {
        folderId: randomUUID(),
        originatingDeploymentId: "deployment",
        originatingDeviceId: "device",
        originatingProfileId: "profile",
        directoryIncarnationId: randomUUID()
      },
      normalizedPath: "/private/project-proof",
      capturedPath: "/private/project-proof",
      observedAt: new Date().toISOString()
    };
    const shared = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: git,
      folderObservation: folder
    });
    const directOnly = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const unresolved = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const project = await repo.createNamedPersonalProject(actor, {
      name: "PRIVATE PROJECT ORGANIZATION"
    });
    const direct = await repo.addPersonalProjectSession(
      actor,
      project.projectId,
      { sessionId: shared.id, expectedVersion: project.version }
    );
    const byGit = await repo.addPersonalProjectRepositoryRule(
      actor,
      project.projectId,
      { repository: git, expectedVersion: direct.project.version }
    );
    const byFolder = await repo.addPersonalProjectFolderRule(
      actor,
      project.projectId,
      {
        folder: { ownerUserId: actor.userId, ...folder.identity },
        expectedVersion: byGit.project.version
      }
    );
    const explicit = await repo.addPersonalProjectSession(
      actor,
      project.projectId,
      { sessionId: directOnly.id, expectedVersion: byFolder.project.version }
    );
    let version = explicit.project.version;
    const sources = await pool.query<{
      id: string;
      logical_session_id: string;
    }>("select id,logical_session_id from sessions where id=any($1::uuid[])", [
      [shared.id, directOnly.id, unresolved.id]
    ]);
    const identities = new Map(
      sources.rows.map((row) => [row.id, row.logical_session_id])
    );
    const target = {
      kind: "project" as const,
      project: { ownerUserId: actor.userId, projectId: project.projectId }
    };
    const evaluate = async () => {
      const baseline = await repo.startPersonalSelectionEnumeration(actor, {
        target
      });
      return {
        baseline,
        result: await repo.evaluatePersonalSelectionMembers(actor, {
          cursor: baseline.changeCursor!,
          sources: [shared, directOnly, unresolved].map((session) => ({
            localSessionId: session.id,
            localLogicalSessionId: identities.get(session.id)!
          }))
        })
      };
    };
    const initial = await evaluate();
    expect(
      initial.baseline.entries.filter(
        (entry) => entry.source.localSessionId === shared.id
      )
    ).toHaveLength(3);
    expect(initial.result.entries.map((entry) => entry.state)).toEqual([
      "matching",
      "matching",
      "unresolved"
    ]);
    const contextBefore = await pool.query(
      "select repository_assignment_version,repository_automatic_identity,repository_override_identity,folder_assignment from sessions where id=$1",
      [shared.id]
    );
    version = (
      await repo.removePersonalProjectInclusion(
        actor,
        project.projectId,
        direct.membership.inclusionId,
        { expectedVersion: version }
      )
    ).project.version;
    expect((await evaluate()).result.entries[0]!.state).toBe("matching");
    expect(
      (
        await pool.query(
          "select repository_assignment_version,repository_automatic_identity,repository_override_identity,folder_assignment from sessions where id=$1",
          [shared.id]
        )
      ).rows
    ).toEqual(contextBefore.rows);
    version = (
      await repo.removePersonalProjectRule(
        actor,
        project.projectId,
        byGit.rule.inclusionId,
        { expectedVersion: version }
      )
    ).project.version;
    expect((await evaluate()).result.entries[0]!.state).toBe("matching");
    version = (
      await repo.removePersonalProjectRule(
        actor,
        project.projectId,
        byFolder.rule.inclusionId,
        { expectedVersion: version }
      )
    ).project.version;
    expect(
      (await evaluate()).result.entries.map((entry) => entry.state)
    ).toEqual(["not_matching", "matching", "not_matching"]);
    const exclusion = await repo.excludePersonalProjectSession(
      actor,
      project.projectId,
      { sessionId: directOnly.id, expectedVersion: version }
    );
    version = exclusion.project.version;
    expect((await evaluate()).result.entries[1]!.state).toBe("not_matching");
    version = (
      await repo.restorePersonalProjectSession(actor, project.projectId, {
        sessionId: directOnly.id,
        expectedVersion: version,
        exclusionId: exclusion.explanation.exclusion!.exclusionId,
        expectedExclusionRevisionId:
          exclusion.explanation.exclusion!.headRevisionId
      })
    ).project.version;
    expect((await evaluate()).result.entries[1]!.state).toBe("matching");
    await repo.deleteNamedPersonalProject(actor, project.projectId, {
      expectedVersion: version
    });
    await expect(
      repo.startPersonalSelectionEnumeration(actor, { target })
    ).rejects.toMatchObject({ code: "selection_unavailable" });
    const sharing = createPersonalSelectionConsumerRepository(pool, {
      includeDeletedProjects: true
    });
    const deleted = await sharing.startPersonalSelectionEnumeration(actor, {
      target
    });
    expect(deleted.entries).toEqual([]);
    const removed = await sharing.evaluatePersonalSelectionMembers(actor, {
      cursor: deleted.changeCursor!,
      sources: [shared, directOnly].map((session) => ({
        localSessionId: session.id,
        localLogicalSessionId: identities.get(session.id)!
      }))
    });
    expect(removed.entries.map((entry) => entry.state)).toEqual([
      "not_matching",
      "not_matching"
    ]);
    expect(JSON.stringify(removed)).not.toContain(project.name);
    expect(JSON.stringify(removed)).not.toContain(git.root!);
  });
  it("takes a bounded baseline, detects stale pages, reconciles missed source/membership/context edits, and preserves owner checks across restart and expiry", async () => {
    let repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const actor = await user(),
      other = await user();
    const git: PersonalGitContext = {
      kind: "portable_repository",
      key: `gr_${randomUUID()}`,
      root: "/private/consumer",
      branch: "main",
      reason: "origin",
      checkoutId: "capture-checkout",
      originatingDeviceId: "capture-device",
      selectedRemote: "origin",
      anchorDisplay: "example.test/consumer"
    };
    const folder: PersonalFolderObservation = {
      identity: {
        folderId: randomUUID(),
        originatingDeploymentId: "capture-deployment",
        originatingDeviceId: "capture-device",
        originatingProfileId: "capture-profile",
        directoryIncarnationId: randomUUID()
      },
      normalizedPath: "/private/consumer/folder",
      capturedPath: "/private/consumer/folder",
      observedAt: new Date().toISOString()
    };
    const project = await repo.createNamedPersonalProject(actor, {
      name: "Consumer selection"
    });
    const target = {
      kind: "project" as const,
      project: { ownerUserId: actor.userId, projectId: project.projectId }
    };
    const empty = await repo.startPersonalSelectionEnumeration(actor, {
      target
    });
    expect(empty.entries).toEqual([]);
    const sessions: Awaited<ReturnType<typeof repo.createCapturedSession>>[] =
      [];
    for (let i = 0; i < 102; i++)
      sessions.push(
        await repo.createCapturedSession(actor, {
          externalSessionId: randomUUID(),
          repositoryIdentity: git,
          folderObservation: folder
        })
      );
    const first = sessions[0]!;
    let version = project.version;
    const included = await repo.addPersonalProjectSession(
      actor,
      project.projectId,
      { sessionId: first.id, expectedVersion: version }
    );
    version = included.project.version;
    const byGit = await repo.addPersonalProjectRepositoryRule(
      actor,
      project.projectId,
      { repository: git, expectedVersion: version }
    );
    version = byGit.project.version;
    const byFolder = await repo.addPersonalProjectFolderRule(
      actor,
      project.projectId,
      {
        folder: { ownerUserId: actor.userId, ...folder.identity },
        expectedVersion: version
      }
    );
    version = byFolder.project.version;
    const event = async (sessionId: string, content: string) =>
      repo.createMemoryEvent(actor, {
        sessionId,
        projectId: "legacy",
        visibility: "personal",
        actor: "user",
        eventType: "captured",
        rawEventType: "user_message",
        content,
        idempotencyKey: randomUUID()
      });
    const started = await repo.startPersonalSelectionEnumeration(actor, {
      target
    });
    expect(started.entries).toHaveLength(100);
    expect(started.nextCursor).not.toBeNull();
    expect(started.changeCursor).toBeNull();
    await expect(
      repo.continuePersonalSelectionEnumeration(other, {
        cursor: started.nextCursor!
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      repo.reconcilePersonalSelectionChanges(other, {
        cursor: empty.changeCursor!
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    const secret = `PRIVATE_CONSUMER_CONTENT_${randomUUID()}`;
    await event(first.id, secret);
    await expect(
      repo.continuePersonalSelectionEnumeration(actor, {
        cursor: started.nextCursor!
      })
    ).rejects.toMatchObject({
      code: "selection_enumeration_stale",
      statusCode: 409
    });
    const baseline = async () => {
      let page = await repo.startPersonalSelectionEnumeration(actor, {
        target
      });
      const entries = [...page.entries],
        snapshot = page.snapshotVersion;
      while (page.nextCursor) {
        page = await repo.continuePersonalSelectionEnumeration(actor, {
          cursor: page.nextCursor
        });
        expect(page.snapshotVersion).toBe(snapshot);
        expect(page.entries.length).toBeLessThanOrEqual(100);
        entries.push(...page.entries);
      }
      expect(page.changeCursor).not.toBeNull();
      return { entries, cursor: page.changeCursor! };
    };
    let historyCursor = empty.changeCursor!,
      historyPages = 0;
    const historyIds: string[] = [];
    for (;;) {
      const history = await repo.reconcilePersonalSelectionChanges(actor, {
        cursor: historyCursor
      });
      historyPages++;
      expect(history.events.length).toBeLessThanOrEqual(100);
      historyIds.push(...history.events.map((e) => e.eventId));
      if (history.nextCursor) {
        historyCursor = history.nextCursor;
        continue;
      }
      break;
    }
    expect(historyPages).toBeGreaterThan(1);
    expect(new Set(historyIds).size).toBe(historyIds.length);
    const current = await baseline();
    expect(
      new Set(current.entries.map((e) => e.source.localSessionId)).size
    ).toBe(102);
    expect(
      current.entries
        .filter((e) => e.source.localSessionId === first.id)
        .map((e) => e.reason.kind)
        .sort()
    ).toEqual(["folder", "repository", "session"]);
    expect(
      current.entries.every(
        (e) =>
          e.source.identityState === "local_only" && e.source.portable === null
      )
    ).toBe(true);
    expect(JSON.stringify(current)).not.toContain(secret);
    const gitPage = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "repository", repository: git }
    });
    expect(gitPage.entries.length).toBe(100);
    expect(gitPage.entries.every((e) => e.reason.kind === "selection")).toBe(
      true
    );
    const folderPage = await repo.startPersonalSelectionEnumeration(actor, {
      target: {
        kind: "folder",
        folder: { ownerUserId: actor.userId, ...folder.identity }
      }
    });
    expect(folderPage.entries.length).toBe(100);
    const local = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "local_session", sessionId: first.id }
    });
    expect(local.entries.map((e) => e.source.localSessionId)).toEqual([
      first.id
    ]);
    await expect(
      repo.startPersonalSelectionEnumeration(other, {
        target: { kind: "local_session", sessionId: first.id }
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    const alternateGit = { ...git, key: `gr_${randomUUID()}` };
    const equalPath = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: alternateGit,
      folderObservation: {
        ...folder,
        identity: { ...folder.identity, directoryIncarnationId: randomUUID() }
      }
    });
    const foreignFolderSource = async (path: string) =>
      repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: { ...git, key: `gr_${randomUUID()}` },
        folderObservation: {
          ...folder,
          identity: {
            ...folder.identity,
            folderId: randomUUID(),
            directoryIncarnationId: randomUUID()
          },
          normalizedPath: path,
          capturedPath: path
        }
      });
    const parent = await foreignFolderSource("/private/consumer"),
      child = await foreignFolderSource("/private/consumer/folder/child");
    const excluded = await repo.excludePersonalProjectSession(
      actor,
      project.projectId,
      { sessionId: first.id, expectedVersion: version }
    );
    version = excluded.project.version;
    await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID(),
      repositoryIdentity: git,
      folderObservation: folder
    });
    await event(sessions[1]!.id, `LATER_TURN_${randomUUID()}`);
    const correction = await repo.previewPersonalSourceCorrection(
      actor,
      sessions[2]!.id,
      {
        axis: "git",
        action: "set",
        repository: alternateGit,
        expectedVersion: 1
      }
    );
    await repo.applyPersonalSourceCorrection(
      actor,
      sessions[2]!.id,
      correction.preview.reviewId,
      { expectedVersion: 1 }
    );
    await repo.removePersonalProjectRule(
      actor,
      project.projectId,
      byFolder.rule.inclusionId,
      { expectedVersion: version }
    );
    await pool.end();
    pool = createDbPool({ connectionString: databaseUrl });
    repo = createMemorySourceRepository(pool, {
      envelopeEncryptionProvider: encryption
    });
    const kinds = new Set<string>();
    let cursor = current.cursor,
      windows = 0;
    for (;;) {
      const changes = await repo.reconcilePersonalSelectionChanges(actor, {
        cursor
      });
      windows++;
      for (const e of changes.events) {
        expect(Object.keys(e).sort()).toEqual(["eventId", "kind"]);
        kinds.add(e.kind);
      }
      expect(JSON.stringify(changes)).not.toContain(secret);
      if (changes.nextCursor) {
        cursor = changes.nextCursor;
        continue;
      }
      cursor = changes.changeCursor!;
      break;
    }
    expect(windows).toBeGreaterThan(0);
    expect(kinds).toEqual(new Set(["source", "membership", "source_context"]));
    const reconciled = await baseline();
    const ids = new Set(reconciled.entries.map((e) => e.source.localSessionId));
    expect(ids.size).toBe(101);
    expect(ids.has(first.id)).toBe(false);
    expect(ids.has(sessions[2]!.id)).toBe(false);
    expect(ids.has(equalPath.id)).toBe(false);
    expect(
      (await repo.reconcilePersonalSelectionChanges(actor, { cursor })).events
    ).toEqual([]);
    let exactFolder = await repo.startPersonalSelectionEnumeration(actor, {
      target: {
        kind: "folder",
        folder: { ownerUserId: actor.userId, ...folder.identity }
      }
    });
    const exactFolderIds = new Set(
      exactFolder.entries.map((e) => e.source.localSessionId)
    );
    while (exactFolder.nextCursor) {
      exactFolder = await repo.continuePersonalSelectionEnumeration(actor, {
        cursor: exactFolder.nextCursor
      });
      for (const entry of exactFolder.entries)
        exactFolderIds.add(entry.source.localSessionId);
    }
    expect(exactFolderIds.size).toBe(103);
    expect(exactFolderIds.has(equalPath.id)).toBe(false);
    expect(exactFolderIds.has(parent.id)).toBe(false);
    expect(exactFolderIds.has(child.id)).toBe(false);
    // Exact Folder matching ignores equal strings on another directory incarnation.
    const exact = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "local_session", sessionId: equalPath.id }
    });
    expect(exact.entries).toHaveLength(1);
    await expect(
      pool.query(
        "update personal_selection_cursors set owner_user_id=$1 where cursor_id=$2",
        [other.userId, reconciled.cursor]
      )
    ).rejects.toThrow();
    await pool.query(
      "update sessions set invalidated_at=now(),invalidation_reason='fixture_source_removed' where owner_user_id=$1 and id=$2",
      [actor.userId, sessions[3]!.id]
    );
    const removal = await repo.reconcilePersonalSelectionChanges(actor, {
      cursor: reconciled.cursor
    });
    expect(removal.events.some((event) => event.kind === "source")).toBe(true);
    const afterRemoval = await baseline();
    expect(
      new Set(afterRemoval.entries.map((entry) => entry.source.localSessionId))
        .size
    ).toBe(100);
    expect(
      afterRemoval.entries.some(
        (entry) => entry.source.localSessionId === sessions[3]!.id
      )
    ).toBe(false);
    await expect(
      repo.startPersonalSelectionEnumeration(actor, {
        target: { kind: "local_session", sessionId: sessions[3]!.id }
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    await expect(
      repo.reconcilePersonalSelectionChanges(actor, {
        cursor: reconciled.cursor
      })
    ).rejects.toMatchObject({
      code: "selection_cursor_expired",
      statusCode: 410
    });
    await expect(
      repo.continuePersonalSelectionEnumeration(actor, {
        cursor: started.nextCursor!
      })
    ).rejects.toMatchObject({ statusCode: 410 });
    vi.restoreAllMocks();
    const latest = await repo.getPersonalMembershipSyncState(
      actor,
      project.projectId
    );
    await repo.deleteNamedPersonalProject(actor, project.projectId, {
      expectedVersion: latest.project.version
    });
    expect(
      (
        await repo.reconcilePersonalSelectionChanges(actor, {
          cursor: reconciled.cursor
        })
      ).reconciliationRequired
    ).toBe(true);
    await expect(
      repo.startPersonalSelectionEnumeration(actor, { target })
    ).rejects.toMatchObject({ code: "selection_unavailable", statusCode: 404 });
  }, 60_000);
  it("notifies completed and invalidated LCM Summaries even when a manual title prevents a Session update", async () => {
    const repo = createMemorySourceRepository(pool);
    const actor = await user(),
      other = await user();
    const session = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const otherSession = await repo.createCapturedSession(other, {
      externalSessionId: randomUUID()
    });
    await repo.createMemoryEvent(actor, {
      sessionId: session.id,
      projectId: "fixture",
      visibility: "personal",
      actor: "user",
      eventType: "captured",
      rawEventType: "user_message",
      content: "A synthetic source whose summary completes after capture.",
      idempotencyKey: randomUUID()
    });
    await pool.query(
      'update sessions set metadata=metadata || \'{"threadName":"Manual title","threadNameSource":"manual"}\'::jsonb where id=$1',
      [session.id]
    );
    let baseline = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "local_session", sessionId: session.id }
    });
    const otherBaseline = await repo.startPersonalSelectionEnumeration(other, {
      target: { kind: "local_session", sessionId: otherSession.id }
    });
    const nodes = await repo.createLcmNodes(actor, {
      visibility: "personal",
      sessionId: session.id,
      force: true,
      finalize: true
    });
    expect(nodes.leafNodeIds.length).toBeGreaterThan(0);
    const created = await repo.reconcilePersonalSelectionChanges(actor, {
      cursor: baseline.changeCursor!
    });
    expect(created.reconciliationRequired).toBe(true);
    baseline = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "local_session", sessionId: session.id }
    });
    await repo.updateLcmNodeSummary({
      nodeId: nodes.leafNodeIds[0]!,
      summaryText: "Completed synthetic summary.",
      summaryModel: "fixture-client",
      summaryPromptVersion: "fixture",
      summaryTokenEstimate: 8,
      summaryStructuredJson: {
        schema_version: "lcm-semantic-summary-v1",
        title: "Generated title",
        summary_text: "Completed synthetic summary.",
        lexical_anchors: []
      },
      summaryStructuredSchemaVersion: "lcm-semantic-summary-v1"
    });
    const completed = await repo.reconcilePersonalSelectionChanges(actor, {
      cursor: baseline.changeCursor!
    });
    expect(completed.reconciliationRequired).toBe(true);
    expect(completed.events.length).toBeGreaterThan(0);
    expect(completed.events.every((event) => event.kind === "source")).toBe(
      true
    );
    expect(JSON.stringify(completed)).not.toContain(
      "Completed synthetic summary"
    );
    expect(
      (
        await pool.query<{ name: string }>(
          "select metadata->>'threadName' name from sessions where id=$1",
          [session.id]
        )
      ).rows[0]!.name
    ).toBe("Manual title");
    expect(
      (
        await repo.reconcilePersonalSelectionChanges(other, {
          cursor: otherBaseline.changeCursor!
        })
      ).events
    ).toEqual([]);
    await repo.invalidateLcmGraphNode(actor, nodes.leafNodeIds[0]!);
    expect(
      (
        await repo.reconcilePersonalSelectionChanges(actor, {
          cursor: completed.changeCursor!
        })
      ).reconciliationRequired
    ).toBe(true);
  });
  it("does not skip a lower allocated journal ID that commits after a completed change window, including rolled-back savepoints", async () => {
    const repo = createMemorySourceRepository(pool),
      actor = await user();
    const session = await repo.createCapturedSession(actor, {
      externalSessionId: randomUUID()
    });
    const baseline = await repo.startPersonalSelectionEnumeration(actor, {
      target: { kind: "local_session", sessionId: session.id }
    });
    const a = await pool.connect(),
      b = await pool.connect();
    try {
      await a.query("begin");
      await a.query("savepoint discarded");
      await a.query(
        "insert into personal_selection_changes(owner_user_id,kind) values($1,'availability')",
        [actor.userId]
      );
      await a.query("rollback to savepoint discarded");
      const slow = await a.query<{ id: string }>(
        "insert into personal_selection_changes(owner_user_id,kind) values($1,'source') returning change_id::text id",
        [actor.userId]
      );
      await b.query("begin");
      const fast = await b.query<{ id: string }>(
        "insert into personal_selection_changes(owner_user_id,kind) values($1,'membership') returning change_id::text id",
        [actor.userId]
      );
      await b.query("commit");
      const first = await repo.reconcilePersonalSelectionChanges(actor, {
        cursor: baseline.changeCursor!
      });
      expect(first.events).toEqual([
        { eventId: fast.rows[0]!.id, kind: "membership" }
      ]);
      await a.query("commit");
      const second = await repo.reconcilePersonalSelectionChanges(actor, {
        cursor: first.changeCursor!
      });
      expect(second.events).toEqual([
        { eventId: slow.rows[0]!.id, kind: "source" }
      ]);
      expect(BigInt(slow.rows[0]!.id) < BigInt(fast.rows[0]!.id)).toBe(true);
      expect(
        (
          await repo.reconcilePersonalSelectionChanges(actor, {
            cursor: second.changeCursor!
          })
        ).events
      ).toEqual([]);
    } finally {
      await a.query("rollback");
      await b.query("rollback");
      a.release();
      b.release();
    }
  });
});
