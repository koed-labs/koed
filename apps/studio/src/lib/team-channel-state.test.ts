import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { confirmedPendingSend, describeStudioCommandFailure, mayPersistTeamDraft, mergeTeamMessages, readCompletionMayApply, readSequenceFor, rememberReadSequence, resolvePendingSend, realtimeUpdateMayAcknowledge, retainPendingSendAfterUncertainOutcome, studioRequestMayApply, studioSelectionMatches, visibleReadMayAdvance } from "./team-channel-state.ts";

test("draft recovery does not save an empty pre-hydration value", () => {
  const authorityKey = JSON.stringify({ backendId: "b", principalUserId: "p", teamId: "t", threadId: "c" });
  assert.equal(mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey: null }), false);
  assert.equal(mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey: authorityKey }), true);
});

test("reconciling an accepted send clears only its pending identity and preserves edits", () => {
  const original = { clientMessageId: "original-id", body: "first exact body", createdAt: "2026-09-28T10:00:00.000Z" };
  const draft = { text: "new edited draft", pendingSend: original };
  assert.deepEqual(confirmedPendingSend(draft, "different-id"), draft);
  assert.deepEqual(confirmedPendingSend(draft, original.clientMessageId), {
    text: "new edited draft",
    pendingSend: null
  });
  assert.equal(original.body, "first exact body");
  assert.equal(original.clientMessageId, "original-id");
});

test("settling an in-flight send preserves edits and never clears a newer send identity", () => {
  const original = { clientMessageId: "original-id", body: "sent body", createdAt: "2026-09-28T10:00:00.000Z" };
  assert.deepEqual(resolvePendingSend({ text: "new text", pendingSend: original }, original.clientMessageId, "accepted", original.body), { text: "new text", pendingSend: null });
  assert.deepEqual(resolvePendingSend({ text: "new text", pendingSend: original }, original.clientMessageId, "not-sent", original.body), { text: "new text", pendingSend: null });
  const newer = { clientMessageId: "newer-id", body: "new request", createdAt: original.createdAt };
  assert.deepEqual(resolvePendingSend({ text: "draft", pendingSend: newer }, original.clientMessageId, "accepted", original.body), { text: "draft", pendingSend: newer });
});

test("ambiguous send errors retain the original identity alongside later edits", () => {
  const original = { clientMessageId: "original-id", body: "exact sent body", createdAt: "2026-09-28T10:00:00.000Z" };
  assert.deepEqual(retainPendingSendAfterUncertainOutcome({ text: "edited while waiting", pendingSend: null }, original), {
    text: "edited while waiting", pendingSend: original
  });
  const newer = { clientMessageId: "newer-id", body: "next", createdAt: original.createdAt };
  assert.deepEqual(retainPendingSendAfterUncertainOutcome({ text: "next draft", pendingSend: newer }, original), { text: "next draft", pendingSend: newer });
});

test("only focused, actually visible incoming messages advance the read cursor", () => {
  const base = { messageId: "m1", sequence: 7, senderId: "member-b", principalUserId: "member-a", lastReportedSequence: 6 };
  assert.equal(visibleReadMayAdvance({ ...base, focused: true }), true);
  assert.equal(visibleReadMayAdvance({ ...base, focused: false }), false);
  assert.equal(visibleReadMayAdvance({ ...base, senderId: "member-a", focused: true }), false);
  assert.equal(visibleReadMayAdvance({ ...base, focused: true, lastReportedSequence: 7 }), false);
});

test("read cursors stay scoped to each Team channel", () => {
  const positions = new Map<string, number>();
  rememberReadSequence(positions, "team-a/channel-a", 60);
  assert.equal(readSequenceFor(positions, "team-a/channel-a"), 60);
  assert.equal(readSequenceFor(positions, "team-b/channel-b"), 0);
  assert.equal(visibleReadMayAdvance({ messageId: "b-first", sequence: 1, senderId: "member-b", principalUserId: "member-a", focused: true, lastReportedSequence: readSequenceFor(positions, "team-b/channel-b") }), true);
  rememberReadSequence(positions, "team-b/channel-b", 1);
  rememberReadSequence(positions, "team-b/channel-b", 0);
  assert.equal(readSequenceFor(positions, "team-b/channel-b"), 1);
});

test("a mark-read response cannot update the cursor after switching channels", () => {
  assert.equal(readCompletionMayApply("team-a/channel-a", "team-a/channel-a"), true);
  assert.equal(readCompletionMayApply("team-a/channel-a", "team-b/channel-b"), false);
  assert.equal(readCompletionMayApply("team-a/channel-a", null), false);
});

test("stale same-Team history can ACK after navigation refresh, while current-channel failures cannot", () => {
  const base = { eventTeamId: "team-a", eventThreadId: "channel-a", currentTeamId: "team-a", historyApplied: false, snapshotApplied: true };
  assert.equal(realtimeUpdateMayAcknowledge({ ...base, currentThreadId: "channel-a" }), false);
  assert.equal(realtimeUpdateMayAcknowledge({ ...base, currentThreadId: "channel-b" }), true);
  assert.equal(realtimeUpdateMayAcknowledge({ ...base, currentTeamId: "team-b", currentThreadId: "channel-b" }), false);
  assert.equal(realtimeUpdateMayAcknowledge({ ...base, currentThreadId: "channel-b", snapshotApplied: false }), false);
});

test("a realtime newest page merges without dropping the loaded older history", () => {
  const make = (id: string, sequence: number) => ({
    id, threadId: "thread", clientMessageId: null, scope: "team" as const, teamId: "team", body: `message ${sequence}`, sequence,
    sender: { id: "member", displayName: "Member", membershipState: "enabled" as const },
    senderKind: "user" as const,
    createdAt: new Date(1_000 + sequence).toISOString(), updatedAt: new Date(1_000 + sequence).toISOString(),
    editedAt: null, deletedAt: null, delivery: "sent" as const, recipientStatus: "read" as const, failure: null
  });
  assert.deepEqual(mergeTeamMessages([make("old-1", 1), make("old-2", 2), make("new-3", 3)], [make("new-3", 3), make("new-4", 4)]).map((item) => item.sequence), [1, 2, 3, 4]);
});

test("late send responses are fenced from a newly selected channel", () => {
  assert.equal(studioSelectionMatches({ teamId: "team-a", threadId: "channel-a" }, { teamId: "team-a", threadId: "channel-a" }), true);
  assert.equal(studioSelectionMatches({ teamId: "team-a", threadId: "channel-a" }, { teamId: "team-b", threadId: "channel-b" }), false);
});

test("late navigation and create responses cannot apply after Team switch or unmount", () => {
  assert.equal(studioRequestMayApply({ capturedGeneration: 4, currentGeneration: 4, mounted: true }), true);
  assert.equal(studioRequestMayApply({ capturedGeneration: 4, currentGeneration: 5, mounted: true }), false);
  assert.equal(studioRequestMayApply({ capturedGeneration: 4, currentGeneration: 4, mounted: false }), false);
});

test("Desktop command rejection becomes visible history status without treating invalid input as revocation", () => {
  assert.deepEqual(describeStudioCommandFailure({ code: "invalid_input", message: "The page request is invalid." }), {
    revoked: false,
    message: "The page request is invalid."
  });
  assert.equal(describeStudioCommandFailure({ code: "access_revoked", message: "Access changed." }).revoked, true);
  assert.equal(describeStudioCommandFailure(new Error("transport failed")).message, "transport failed");
});
