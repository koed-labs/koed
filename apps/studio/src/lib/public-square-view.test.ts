import assert from "node:assert/strict";
import test from "node:test";
import type { PublicSquarePublication } from "@/lib/public-square";
import {
  buildPublicSquareModel,
  groupWaitingJobsByUser,
  shouldShowPublicSquareMap,
  toSquareJob
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./public-square-view.ts";

const publication = (
  overrides: Partial<PublicSquarePublication> = {}
): PublicSquarePublication => ({
  id: "pub-1",
  jobId: "job-1",
  agentId: "agent-1",
  agentName: "Builder",
  ownerId: "owner-1",
  ownerName: "Maya",
  projectId: "project-1",
  projectName: "Studio",
  ownerExecutionId: null,
  status: "running",
  lastKnownStatus: null,
  phase: null,
  phaseObservedAt: null,
  publishedAt: "2026-10-01T09:00:00.000Z",
  startedAt: "2026-10-01T09:05:00.000Z",
  updatedAt: "2026-10-01T09:10:00.000Z",
  completedAt: null,
  lastSeenAt: null,
  waitingOn: null,
  ownerLeftTeam: false,
  sharedBrief: null,
  version: 1,
  canEditBrief: false,
  canRemoveRetainedBrief: false,
  ...overrides
});

test("keeps the map visible when explicitly available idle Agents are the only entries", () => {
  assert.equal(
    shouldShowPublicSquareMap({
      jobs: [],
      rooms: [],
      historicalItems: [],
      idleAgentCount: 1
    }),
    true
  );
  assert.equal(
    shouldShowPublicSquareMap({
      jobs: [],
      rooms: [],
      historicalItems: [],
      idleAgentCount: 0
    }),
    false
  );
});

test("maps only authoritative waiting requests to an actionable viewer highlight", () => {
  const mine = toSquareJob(
    publication({
      status: "waiting",
      startedAt: null,
      waitingOn: { userId: "viewer-1", name: "You" }
    }),
    "viewer-1"
  );
  const colleague = toSquareJob(
    publication({
      id: "pub-2",
      jobId: "job-2",
      status: "waiting",
      startedAt: null,
      waitingOn: { userId: "owner-2", name: "Kai" }
    }),
    "viewer-1"
  );
  const unknown = toSquareJob(
    publication({ status: "waiting", startedAt: null }),
    "viewer-1"
  );

  assert.equal(mine.waitingOnViewer, true);
  assert.equal(colleague.waitingOnViewer, false);
  assert.equal(unknown.waitingOn, null);
  assert.equal(unknown.startedAt, null);
});

test("groups waiting Jobs by respondent ID rather than shared display name", () => {
  const first = toSquareJob(
    publication({
      status: "waiting",
      waitingOn: { userId: "user-2", name: "Sam" }
    }),
    "viewer-1"
  );
  const second = toSquareJob(
    publication({
      id: "pub-2",
      jobId: "job-2",
      status: "waiting",
      waitingOn: { userId: "user-3", name: "Sam" }
    }),
    "viewer-1"
  );
  const mine = toSquareJob(
    publication({
      id: "pub-3",
      jobId: "job-3",
      status: "waiting",
      waitingOn: { userId: "viewer-1", name: "Sam" }
    }),
    "viewer-1"
  );
  const groups = groupWaitingJobsByUser([first, second, mine], "viewer-1");

  assert.equal(groups.size, 2);
  assert.deepEqual([...groups.keys()], ["user-2", "user-3"]);
  assert.deepEqual(
    [...groups.values()],
    [
      { name: "Sam", count: 1 },
      { name: "Sam", count: 1 }
    ]
  );
});

test("uses checking only for a running Job with an explicit phase", () => {
  const checking = toSquareJob(publication({ phase: "checking" }), "viewer-1");
  const offline = toSquareJob(
    publication({
      status: "offline",
      lastKnownStatus: "running",
      phase: "checking"
    }),
    "viewer-1"
  );
  const waiting = toSquareJob(
    publication({ status: "waiting", startedAt: null, phase: "checking" }),
    "viewer-1"
  );

  assert.equal(checking.zone, "checking");
  assert.equal(checking.statusLabel, "Checking");
  assert.equal(offline.zone, "offline");
  assert.equal(waiting.zone, "waiting");
});

test("keeps queued, offline, duplicate-agent Jobs, and former-owner history distinct", () => {
  const queued = publication({ status: "queued", startedAt: null });
  const offline = publication({
    id: "pub-2",
    jobId: "job-2",
    status: "offline",
    lastKnownStatus: "running",
    lastSeenAt: "2026-10-01T09:12:00.000Z",
    waitingOn: null
  });
  const duplicate = publication({ id: "pub-3", jobId: "job-3" });
  const formerOwner = publication({
    id: "pub-4",
    jobId: "job-4",
    ownerLeftTeam: true
  });
  const model = buildPublicSquareModel({
    items: [queued, offline, duplicate, formerOwner],
    projects: [{ id: "project-1", name: "Studio" }],
    viewerId: "viewer-1"
  });

  assert.deepEqual(
    model.jobs.map((job) => job.id),
    ["pub-1", "pub-2", "pub-3"]
  );
  assert.equal(model.jobs.find((job) => job.id === "pub-1")?.zone, "waiting");
  assert.equal(
    model.jobs.find((job) => job.id === "pub-1")?.statusLabel,
    "Queued"
  );
  assert.equal(model.jobs.find((job) => job.id === "pub-2")?.zone, "offline");
  assert.equal(model.jobs.find((job) => job.id === "pub-2")?.waitingOn, null);
  assert.equal(model.historicalItems[0]?.ownerLeftTeam, true);
  assert.equal(model.counts.working, 1);
  assert.equal(model.counts.queued, 1);
});
