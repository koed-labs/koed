import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDbPool,
  runDbMigrations,
  createMemorySourceRepository,
  updateSessionRepositoryOverride
} from "../src/index.js";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("fixed repository assignment reviews", () => {
  const pool = createDbPool({ connectionString: url });
  const repo = createMemorySourceRepository(pool);
  beforeAll(() => runDbMigrations(pool));
  afterAll(() => pool.end());
  const fixture = async () => {
    const actor = {
      userId: (
        await repo.createUser({ email: `review-${randomUUID()}@example.test` })
      ).id
    };
    const a: RepositoryIdentity = {
      kind: "portable_repository",
      key: "gr_a",
      root: "/same/path",
      branch: "main",
      reason: "origin",
      checkoutId: `checkout_${randomUUID()}`,
      originatingDeviceId: `pms_${randomUUID()}`,
      selectedRemote: "origin",
      anchorDisplay: "example.test/a"
    };
    const b: RepositoryIdentity = {
      ...a,
      key: "gr_b",
      anchorDisplay: "example.test/b"
    };
    const capture = async (identity = a) => {
      const session = await repo.createCapturedSession(actor, {
        externalSessionId: randomUUID(),
        repositoryIdentity: identity,
        cwd: `${identity.root}/cli`,
        metadata: { threadName: "Copper checklist" }
      });
      const event = await repo.createMemoryEvent(actor, {
        projectId: repositoryScopeId(identity),
        sessionId: session.id,
        actor: "user",
        visibility: "personal",
        eventType: "captured",
        rawEventType: "user_message",
        content: "Copper checklist",
        idempotencyKey: randomUUID()
      });
      return { session, event };
    };
    const change = async (target = b, revision = 1) =>
      repo.recordRepositoryChange(actor, {
        id: randomUUID(),
        kind: "anchor_change",
        originatingDeviceId: a.originatingDeviceId,
        checkoutId: a.checkoutId!,
        originatingRevision: revision,
        previousIdentity: a,
        targetIdentity: target
      });
    return { actor, a, b, capture, change };
  };
  it("retains fixed read-only review snapshots while later capture preserves recorded sources", async () => {
    const f = await fixture();
    const first = await f.capture(),
      second = await f.capture();
    await f.capture({ ...f.a, checkoutId: "different_incarnation" });
    const event = await f.change();
    const review = await repo.createRepositoryAssignmentReview(
      f.actor,
      event.id,
      { includeOverrides: false, includeUnresolved: false }
    );
    expect(review.sessions.map((source) => source.id).sort()).toEqual(
      [first.session.id, second.session.id].sort()
    );
    const late = await f.capture();
    expect(
      (await repo.getRepositoryAssignmentReview(f.actor, review.id)).sessions
    ).toEqual(review.sessions);
    expect(
      review.sessions.some((source) => source.id === late.session.id)
    ).toBe(false);
    for (const source of [first, second, late])
      expect(
        (await repo.getCapturedSession(f.actor, source.session.id))
          ?.repositoryAssignment
      ).toMatchObject({ automatic: f.a, effective: f.a, version: 1 });
    expect(
      await repo.listLcmGraphThreads(f.actor, {
        projectId: repositoryScopeId(f.b)
      })
    ).toEqual([]);
  });
  it("keeps read-only reviews owner-bound after a newer source edit", async () => {
    const f = await fixture();
    const first = await f.capture(),
      second = await f.capture();
    const event = await f.change();
    const review = await repo.createRepositoryAssignmentReview(
      f.actor,
      event.id,
      { includeOverrides: false, includeUnresolved: false }
    );
    await updateSessionRepositoryOverride(pool, {
      ownerUserId: f.actor.userId,
      sessionId: second.session.id,
      identity: f.b,
      expectedVersion: 1
    });
    expect(
      (await repo.getRepositoryAssignmentReview(f.actor, review.id)).sessions
    ).toEqual(review.sessions);
    expect(
      (await repo.getCapturedSession(f.actor, first.session.id))
        ?.repositoryAssignment?.version
    ).toBe(1);
    const other = (await fixture()).actor;
    await expect(
      repo.createRepositoryAssignmentReview(other, event.id, {
        includeOverrides: false,
        includeUnresolved: false
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      repo.executeRepositoryAssignmentReview(other, review.id, {
        action: "dismiss",
        expectedRevision: event.revision
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("excludes overrides and unresolved history by default and includes them only explicitly", async () => {
    const f = await fixture();
    const overridden = await f.capture(),
      historical = await f.capture();
    await pool.query(
      "update sessions set repository_automatic_identity=null,repository_assignment_state='historical_unresolved' where id=$1",
      [historical.session.id]
    );
    await updateSessionRepositoryOverride(pool, {
      ownerUserId: f.actor.userId,
      sessionId: overridden.session.id,
      identity: f.b,
      expectedVersion: 1
    });
    const event = await f.change();
    expect(
      (
        await repo.createRepositoryAssignmentReview(f.actor, event.id, {
          includeOverrides: false,
          includeUnresolved: false
        })
      ).count
    ).toBe(0);
    const review = await repo.createRepositoryAssignmentReview(
      f.actor,
      event.id,
      { includeOverrides: true, includeUnresolved: true }
    );
    expect(review.count).toBe(2);
    expect(
      review.sessions.find((s) => s.id === overridden.session.id)?.assignment
        .override
    ).toEqual(f.b);
    expect(
      (await repo.getCapturedSession(f.actor, historical.session.id))
        ?.repositoryAssignment
    ).toMatchObject({
      state: "historical_unresolved",
      automatic: null,
      effective: null
    });
  });
  it("supersedes A-to-B after B-to-C, rejects old revisions, and dismisses without assignment changes", async () => {
    const f = await fixture();
    const sample = await f.capture();
    const ab = await f.change();
    const review = await repo.createRepositoryAssignmentReview(f.actor, ab.id, {
      includeOverrides: false,
      includeUnresolved: false
    });
    const c = { ...f.b, key: "gr_c" };
    const bc = await f.change(c, 2);
    expect(bc.previousIdentity).toEqual(f.b);
    expect(
      (await repo.listRepositoryChanges(f.actor)).map((e) => e.id)
    ).toEqual([bc.id]);
    const delayed = await f.change(f.a, 1);
    expect(delayed.status).toBe("superseded");
    await expect(
      repo.executeRepositoryAssignmentReview(f.actor, review.id, {
        action: "dismiss",
        expectedRevision: ab.revision
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    const next = await repo.createRepositoryAssignmentReview(f.actor, bc.id, {
      includeOverrides: false,
      includeUnresolved: false
    });
    await repo.executeRepositoryAssignmentReview(f.actor, next.id, {
      action: "dismiss",
      expectedRevision: bc.revision
    });
    expect(
      (await repo.getCapturedSession(f.actor, sample.session.id))
        ?.repositoryAssignment?.version
    ).toBe(1);
    expect(await repo.listRepositoryChanges(f.actor)).toEqual([]);
    const nextChange = await f.change({ ...c, key: "gr_d" }, 3);
    expect(nextChange.previousIdentity).toEqual(c);
    expect(nextChange.revision).toBeGreaterThan(delayed.revision);
  });
  it("records capture conflicts without replacing the recorded assignment or creating repeated pending work", async () => {
    const f = await fixture();
    const nativeId = randomUUID();
    const session = await repo.createCapturedSession(f.actor, {
      externalSessionId: nativeId,
      repositoryIdentity: f.a
    });
    await repo.createCapturedSession(f.actor, {
      externalSessionId: nativeId,
      repositoryIdentity: f.b
    });
    const events = await repo.listRepositoryChanges(f.actor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "capture_conflict",
      previousIdentity: f.a,
      targetIdentity: f.b
    });
    expect(
      (await repo.getCapturedSession(f.actor, session.id))?.repositoryAssignment
        ?.automatic
    ).toEqual(f.a);
    await repo.createCapturedSession(f.actor, {
      externalSessionId: nativeId,
      repositoryIdentity: { ...f.b, branch: "feature" }
    });
    expect(await repo.listRepositoryChanges(f.actor)).toHaveLength(1);
  });
});
