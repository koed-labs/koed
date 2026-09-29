import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { confirmedPendingSend, describeStudioCommandFailure, directMessageAttemptKey, directMessageParticipantsAreEligible, directMessageThreadMatchesRequest, durableSendFailureDisposition, durableSendMatchesAuthority, durableSendStatus, mayCompleteDraftHydration, mayPersistTeamDraft, mergeTeamMessages, readCompletionMayApply, readSequenceFor, rememberReadSequence, resolvePendingSend, realtimeUpdateMayAcknowledge, retainPendingSendAfterUncertainOutcome, studioRequestMayApply, studioSelectionMatches, teamDraftForHydration, visibleReadMayAdvance } from "./team-channel-state.ts";

test("draft recovery does not save an empty pre-hydration value", () => {
  const authorityKey = JSON.stringify({ backendId: "b", principalUserId: "p", teamId: "t", threadId: "c" });
  assert.equal(mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey: null }), false);
  assert.equal(mayPersistTeamDraft({ authorityKey, hydratedAuthorityKey: authorityKey }), true);
});

test("late draft hydration cannot apply after revocation or authority cleanup", () => {
  assert.equal(mayCompleteDraftHydration({ active: true, revoked: false }), true);
  assert.equal(mayCompleteDraftHydration({ active: true, revoked: true }), false);
  assert.equal(mayCompleteDraftHydration({ active: false, revoked: false }), false);
});

test("a missing saved draft still completes authorized hydration with an empty editable draft", () => {
  assert.deepEqual(teamDraftForHydration(null), { text: "", pendingSend: null });
  const stored = { text: "saved", pendingSend: null, updatedAt: "2026-09-28T10:00:00.000Z" };
  assert.equal(teamDraftForHydration(stored), stored);
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

test("known permanent send failures restore the original body only when no newer draft exists", () => {
  const pending = { clientMessageId: "original-id", body: "rejected body", createdAt: "2026-09-28T10:00:00.000Z" };
  assert.deepEqual(resolvePendingSend({ text: "", pendingSend: pending }, pending.clientMessageId, "not-sent", pending.body), {
    text: pending.body, pendingSend: null
  });
  assert.deepEqual(resolvePendingSend({ text: "newer edits", pendingSend: pending }, pending.clientMessageId, "not-sent", pending.body), {
    text: "newer edits", pendingSend: null
  });
  assert.equal(durableSendFailureDisposition("invalid_input"), "not_sent");
  assert.equal(durableSendFailureDisposition(null), "not_sent");
  for (const code of ["access_revoked", "permission_denied", "not_available"]) {
    assert.equal(durableSendFailureDisposition(code), "authority_lost");
  }
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

test("direct-message retries use a stable participant-set key and reject self or disabled members", () => {
  assert.equal(directMessageAttemptKey("team", "owner", ["b", "a"]), directMessageAttemptKey("team", "owner", ["a", "b"]));
  assert.notEqual(directMessageAttemptKey("team", "owner", ["a", "b"]), directMessageAttemptKey("team", "other-owner", ["a", "b"]));
  const enabledMemberIds = new Set(["a", "b"]);
  assert.equal(directMessageParticipantsAreEligible({ principalUserId: "me", participantUserIds: ["a"], enabledMemberIds }), true);
  assert.equal(directMessageParticipantsAreEligible({ principalUserId: "me", participantUserIds: ["me"], enabledMemberIds }), false);
  assert.equal(directMessageParticipantsAreEligible({ principalUserId: "me", participantUserIds: ["disabled"], enabledMemberIds }), false);
  assert.equal(directMessageParticipantsAreEligible({ principalUserId: "me", participantUserIds: ["a", "a"], enabledMemberIds }), false);
});

test("created direct messages must match the requested Team, kind, and exact participant set", () => {
  const base = { requestedTeamId: "team", principalUserId: "me", participantUserIds: ["alice"] };
  const thread = { scope: "team", teamId: "team", kind: "dm", participants: [{ id: "me" }, { id: "alice" }] };
  assert.equal(directMessageThreadMatchesRequest({ ...base, thread }), true);
  assert.equal(directMessageThreadMatchesRequest({
    ...base,
    participantUserIds: ["alice", "bob"],
    thread: { scope: "team", teamId: "team", kind: "group_dm", participants: [{ id: "me" }, { id: "alice" }, { id: "bob" }] }
  }), true);
  assert.equal(directMessageThreadMatchesRequest({ ...base, thread: { ...thread, teamId: "other" } }), false);
  assert.equal(directMessageThreadMatchesRequest({ ...base, thread: { ...thread, kind: "group_dm" } }), false);
  assert.equal(directMessageThreadMatchesRequest({ ...base, thread: { ...thread, participants: [...thread.participants, { id: "outsider" }] } }), false);
  assert.equal(directMessageThreadMatchesRequest({ ...base, thread: { ...thread, participants: [{ id: "me" }, { id: "other" }] } }), false);
});

test("durable send events apply only to the exact account, Team, and thread", () => {
  const authority = { backendId: "backend", principalUserId: "owner", teamId: "team", threadId: "thread" };
  const send = { authority: { scope: "team" as const, ...authority, workspaceId: null } };
  assert.equal(durableSendMatchesAuthority(send, JSON.stringify(authority)), true);
  assert.equal(durableSendMatchesAuthority(send, JSON.stringify({ ...authority, principalUserId: "other" })), false);
  assert.equal(durableSendMatchesAuthority(send, JSON.stringify({ ...authority, backendId: "other" })), false);
  assert.equal(durableSendMatchesAuthority(send, JSON.stringify({ ...authority, teamId: "other" })), false);
  assert.equal(durableSendMatchesAuthority(send, JSON.stringify({ ...authority, threadId: "other" })), false);
  assert.equal(durableSendMatchesAuthority(send, null), false);
  assert.equal(durableSendStatus({ state: "queued", failure: null }), "Sending…");
  assert.equal(durableSendStatus({ state: "manual_retry", failure: null }), "Send is queued for retry.");
  assert.equal(durableSendStatus({ state: "failed", failure: null }), "Message could not be sent.");
  assert.equal(durableSendStatus({ state: "sent", failure: null }), null);
});

test("Desktop command rejection becomes visible history status without treating invalid input as revocation", () => {
  assert.deepEqual(describeStudioCommandFailure({ code: "invalid_input", message: "The page request is invalid." }), {
    revoked: false,
    message: "The page request is invalid."
  });
  assert.equal(describeStudioCommandFailure({ code: "access_revoked", message: "Access changed." }).revoked, true);
  assert.equal(describeStudioCommandFailure(new Error("transport failed")).message, "transport failed");
});
