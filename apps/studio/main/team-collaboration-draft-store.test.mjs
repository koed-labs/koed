import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createStudioTeamDraftStore } from "./team-collaboration-draft-store.mjs";

const userDataPaths = [];
const createPath = async () => {
  const path = await mkdtemp(join(tmpdir(), "koed-studio-team-drafts-"));
  userDataPaths.push(path);
  return path;
};

after(async () => {
  await Promise.all(
    userDataPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const authority = {
  backendId: "backend-one",
  principalUserId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  threadId: "33333333-3333-4333-8333-333333333333"
};

const pendingSend = {
  clientMessageId: "44444444-4444-4444-8444-444444444444",
  body: "Draft body that must remain byte-for-byte stable.",
  createdAt: "2026-09-27T18:00:00.000Z"
};
const mentionUserIds = ["99999999-9999-4999-8999-999999999999"];

describe("Studio Team draft store", () => {
  it("encrypts drafts at rest and restores the exact uncertain send after restart", async () => {
    const userDataPath = await createPath();
    const first = createStudioTeamDraftStore({ userDataPath });
    await first.save({
      authority,
      draft: { text: "Unsaved edit", pendingSend, mentionUserIds }
    });

    const stored = await readFile(
      join(userDataPath, "team-collaboration-drafts.json"),
      "utf8"
    );
    assert.equal(stored.includes("Unsaved edit"), false);
    assert.equal(stored.includes(pendingSend.body), false);
    assert.equal(stored.includes(pendingSend.clientMessageId), false);

    const afterRestart = createStudioTeamDraftStore({ userDataPath });
    assert.deepEqual(await afterRestart.load(authority), {
      text: "Unsaved edit",
      mentionUserIds,
      pendingSend,
      receiptAckPending: null,
      updatedAt: (await afterRestart.load(authority)).updatedAt
    });
  });

  it("restores a marker-only completion receipt after restart and validates its exact IDs", async () => {
    const userDataPath = await createPath();
    const receiptAckPending = {
      clientMessageId: "77777777-7777-4777-8777-777777777777",
      messageId: "88888888-8888-4888-8888-888888888888"
    };
    const first = createStudioTeamDraftStore({ userDataPath });
    await first.save({
      authority,
      draft: { text: "", pendingSend: null, receiptAckPending }
    });
    const afterRestart = createStudioTeamDraftStore({ userDataPath });
    assert.deepEqual(await afterRestart.load(authority), {
      text: "",
      pendingSend: null,
      receiptAckPending,
      updatedAt: (await afterRestart.load(authority)).updatedAt
    });
    await assert.rejects(
      first.save({
        authority,
        draft: {
          text: "",
          pendingSend: null,
          receiptAckPending: { ...receiptAckPending, messageId: "bad" }
        }
      }),
      /invalid/
    );
  });

  it("isolates by backend, principal, Team, and thread, then removes revoked Team state", async () => {
    const userDataPath = await createPath();
    const store = createStudioTeamDraftStore({ userDataPath });
    await store.save({
      authority,
      draft: { text: "Team one", pendingSend: null }
    });
    const otherTeam = {
      ...authority,
      teamId: "55555555-5555-4555-8555-555555555555"
    };
    const otherThread = {
      ...authority,
      threadId: "66666666-6666-4666-8666-666666666666"
    };
    assert.equal(await store.load(otherTeam), null);
    assert.equal(await store.load(otherThread), null);

    await store.deleteTeam({
      backendId: authority.backendId,
      principalUserId: authority.principalUserId,
      teamId: authority.teamId
    });
    assert.equal(await store.load(authority), null);
  });

  it("preserves the original body and idempotency ID if the edited draft is saved separately", async () => {
    const store = createStudioTeamDraftStore({
      userDataPath: await createPath()
    });
    const editedAuthority = {
      ...authority,
      threadId: "77777777-7777-4777-8777-777777777777"
    };
    await store.save({
      authority: editedAuthority,
      draft: { text: "New text after timeout", pendingSend }
    });
    const restored = await store.load(editedAuthority);
    assert.equal(
      restored.pendingSend.clientMessageId,
      pendingSend.clientMessageId
    );
    assert.equal(restored.pendingSend.body, pendingSend.body);
    assert.equal(restored.text, "New text after timeout");
  });

  it("isolates reply and edit drafts by root/message while preserving the edit conflict basis", async () => {
    const store = createStudioTeamDraftStore({
      userDataPath: await createPath()
    });
    const rootMessageId = "99999999-9999-4999-8999-999999999999";
    const editMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const replyAuthority = { ...authority, rootMessageId };
    const editAuthority = { ...authority, editMessageId };
    const editDraft = {
      text: "My unsaved revision",
      pendingSend: null,
      edit: {
        expectedVersion: 2,
        baseBodyText: "Original text",
        conflict: {
          latestVersion: 3,
          latestBodyText: "Someone else's saved edit"
        }
      }
    };
    await store.save({
      authority: replyAuthority,
      draft: { text: "Reply draft", pendingSend: null }
    });
    await store.save({ authority: editAuthority, draft: editDraft });

    assert.deepEqual(await store.load(replyAuthority), {
      text: "Reply draft",
      pendingSend: null,
      receiptAckPending: null,
      updatedAt: (await store.load(replyAuthority)).updatedAt
    });
    assert.deepEqual(await store.load(editAuthority), {
      ...editDraft,
      receiptAckPending: null,
      updatedAt: (await store.load(editAuthority)).updatedAt
    });
    assert.equal(
      await store.load({ ...authority, rootMessageId: editMessageId }),
      null
    );
    assert.equal(
      await store.load({ ...authority, editMessageId: rootMessageId }),
      null
    );
    await assert.rejects(
      store.load({ ...authority, rootMessageId, editMessageId }),
      /invalid/
    );
    await assert.rejects(
      store.save({
        authority: { ...authority, editMessageId },
        draft: {
          ...editDraft,
          edit: {
            ...editDraft.edit,
            conflict: { latestVersion: 2, latestBodyText: "stale" }
          }
        }
      }),
      /invalid/
    );
  });

  it("purges a Team that disappeared while Studio was closed", async () => {
    const userDataPath = await createPath();
    const beforeRestart = createStudioTeamDraftStore({ userDataPath });
    await beforeRestart.save({
      authority,
      draft: { text: "Removed Team draft", pendingSend }
    });
    const afterRestart = createStudioTeamDraftStore({ userDataPath });
    assert.equal(
      await afterRestart.retainAuthorizedTeams({
        backendId: authority.backendId,
        principalUserId: authority.principalUserId,
        teamIds: []
      }),
      1
    );
    assert.equal(await afterRestart.load(authority), null);
    const state = JSON.parse(
      await readFile(
        join(userDataPath, "team-collaboration-drafts.json"),
        "utf8"
      )
    );
    assert.deepEqual(Object.keys(state.secrets), []);
  });

  it("finishes queued saves before fresh authorization pruning, across store instances", async () => {
    const userDataPath = await createPath();
    const first = createStudioTeamDraftStore({ userDataPath });
    const second = createStudioTeamDraftStore({ userDataPath });
    const save = first.save({
      authority,
      draft: { text: "queued before removal", pendingSend }
    });
    const prune = second.retainAuthorizedTeams({
      backendId: authority.backendId,
      principalUserId: authority.principalUserId,
      teamIds: []
    });
    await Promise.all([save, prune]);
    assert.equal(await first.load(authority), null);
    assert.equal(
      await second.retainAuthorizedTeams({
        backendId: authority.backendId,
        principalUserId: authority.principalUserId,
        teamIds: []
      }),
      0
    );
  });

  it("rejects malformed and oversized drafts before writing", async () => {
    const store = createStudioTeamDraftStore({
      userDataPath: await createPath()
    });
    await assert.rejects(
      store.save({ authority, draft: { text: "bad", pendingSend: {} } }),
      /invalid/
    );
    await assert.rejects(
      store.save({
        authority,
        draft: { text: "x".repeat(128 * 1024 + 1), pendingSend: null }
      }),
      /invalid/
    );
  });
});
