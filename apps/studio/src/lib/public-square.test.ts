import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { publicSquareBriefEditorValue, publicSquareConnectableLocalProjects, publicSquareIsCurrent, publicSquareNeedsOwnerDraft, publicSquareProjectIdKey, publicSquareRequestMayApply, publicSquareScopeKey, publicSquareSortGroups, publicSquareStatusLabel, publicSquareVisibleBrief, publicSquareVisibleItems } from "./public-square.ts";
import type { PublicSquarePublication } from "./public-square.ts";

const publication = (overrides: Partial<PublicSquarePublication> = {}): PublicSquarePublication => ({
  id: "publication-a", jobId: "job-a", agentId: "agent-a", agentName: "Review agent",
  ownerId: "owner-a", ownerName: "Ari", projectId: "project-a", projectName: "Koed",
  status: "running", lastKnownStatus: null, publishedAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z", completedAt: null, lastSeenAt: null,
  ownerLeftTeam: false, sharedBrief: "Review the release notes.", version: 1,
  canEditBrief: false, canRemoveRetainedBrief: false, ...overrides
});

test("late Public Square responses require the same account, Team, generation, and active authorization", () => {
  const scope = publicSquareScopeKey({ backendId: "https://account-a", principalUserId: "user-a", teamId: "team-a" });
  assert.equal(publicSquareRequestMayApply({ capturedScopeKey: scope, currentScopeKey: scope, capturedGeneration: 2, currentGeneration: 2, mounted: true, accessLost: false }), true);
  assert.equal(publicSquareRequestMayApply({ capturedScopeKey: scope, currentScopeKey: publicSquareScopeKey({ backendId: "https://account-b", principalUserId: "user-a", teamId: "team-a" }), capturedGeneration: 2, currentGeneration: 2, mounted: true, accessLost: false }), false);
  assert.equal(publicSquareRequestMayApply({ capturedScopeKey: scope, currentScopeKey: scope, capturedGeneration: 1, currentGeneration: 2, mounted: true, accessLost: false }), false);
  assert.equal(publicSquareRequestMayApply({ capturedScopeKey: scope, currentScopeKey: scope, capturedGeneration: 2, currentGeneration: 2, mounted: true, accessLost: true }), false);
  assert.equal(publicSquareRequestMayApply({ capturedScopeKey: scope, currentScopeKey: scope, capturedGeneration: 2, currentGeneration: 2, mounted: false, accessLost: false }), false);
});

test("connection refresh dependencies stay stable when Team Project display arrays are recreated", () => {
  assert.equal(publicSquareProjectIdKey([{ id: "project-b", name: "B" }, { id: "project-a", name: "A" }]), "project-a\u0000project-b");
  assert.equal(publicSquareProjectIdKey([{ id: "project-a", name: "Renamed" }, { id: "project-b", name: "B" }]), "project-a\u0000project-b");
  assert.equal(publicSquareProjectIdKey([{ id: "project-a", name: "A" }, { id: "project-a", name: "A" }]), "project-a");
});

test("local Project picker excludes the projectless sentinel by ID, not by display name", () => {
  const projects = [
    { id: "unassigned", name: "Unassigned" },
    { id: "project-a", name: "Unassigned" },
    { id: "project-b", name: "Product" }
  ];
  assert.deepEqual(publicSquareConnectableLocalProjects(projects), projects.slice(1));
});

test("an existing shared brief stays the editor value and does not load the generated owner draft", () => {
  const item = publication({ canEditBrief: true, sharedBrief: "Reviewed team brief" });
  assert.equal(publicSquareBriefEditorValue(item, undefined, "Private generated draft"), "Reviewed team brief");
  assert.equal(publicSquareNeedsOwnerDraft(item, undefined), false);
  assert.equal(publicSquareBriefEditorValue(item, "Owner edit in progress", "Private generated draft"), "Owner edit in progress");
  assert.equal(publicSquareNeedsOwnerDraft(publication({ canEditBrief: true, sharedBrief: null }), undefined), true);
});

test("an accepted withdrawal with a lost acknowledgement stays hidden from a late prior page", () => {
  const oldResponse = publication();
  const optimisticallyWithdrawnIds = new Set([oldResponse.id]);
  assert.equal(publicSquareVisibleBrief(oldResponse, optimisticallyWithdrawnIds), null);
  // A timeout cannot establish whether the server committed the withdrawal.
  // Keep the optimistic hide until a definite rejection and a fresh read.
  assert.equal(publicSquareVisibleBrief(oldResponse, optimisticallyWithdrawnIds), null);
  assert.equal(publicSquareVisibleBrief(publication({ sharedBrief: null }), new Set()), null);
});

test("an unshare with a lost acknowledgement hides late cards from that Project", () => {
  const oldResponse = [publication(), publication({ id: "publication-b", projectId: "project-b" })];
  const hiddenProjects = new Set(["project-a"]);
  assert.deepEqual(publicSquareVisibleItems(oldResponse, hiddenProjects).map((item) => item.id), ["publication-b"]);
  // A retrying list read can still race the server's unshare commit; retain the project hide.
  assert.deepEqual(publicSquareVisibleItems(oldResponse, hiddenProjects).map((item) => item.id), ["publication-b"]);
});

test("owner-departure records are separated from current work and groups stay project-based", () => {
  const first = publication();
  const second = publication({ id: "publication-b", projectId: "project-b", projectName: "Agent Tools" });
  const former = publication({ id: "publication-c", ownerLeftTeam: true, projectId: "project-a" });
  const completed = publication({ id: "publication-d", status: "succeeded", completedAt: "2026-09-30T11:00:00.000Z" });
  assert.equal(publicSquareIsCurrent(first), true);
  assert.equal(publicSquareIsCurrent(former), false);
  assert.equal(publicSquareIsCurrent(completed), false);
  assert.equal(publicSquareIsCurrent(publication({ status: "offline", lastKnownStatus: "failed" })), false);
  assert.deepEqual(publicSquareSortGroups([second, first]).map((group) => [group.projectName, group.items.length]), [["Agent Tools", 1], ["Koed", 1]]);
});

test("status labels normalize transport spellings without exposing raw output", () => {
  assert.equal(publicSquareStatusLabel("needs_input"), "Needs Input");
  assert.equal(publicSquareStatusLabel("in-progress"), "In Progress");
  assert.equal(publicSquareStatusLabel(""), "Status unavailable");
});
