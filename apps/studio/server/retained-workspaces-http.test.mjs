import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRetainedWorkspaces } from "./retained-workspaces-http.mjs";

const executionId = "11111111-1111-4111-8111-111111111111";
const otherExecutionId = "22222222-2222-4222-8222-222222222222";
const moveId = "33333333-3333-4333-8333-333333333333";
const base = `http://127.0.0.1/studio-api/managed-conversations/${executionId}/retained-workspaces`;
const record = {
  moveId,
  executionId,
  sourceProjectId: "lp_source",
  sourcePath: "/tmp/retained-worktree",
  reason: "changed",
  retainedAt: "2026-09-26T00:00:00.000Z"
};

const run = async ({
  pathname = base,
  method = "GET",
  authorized = true,
  records = [record, { ...record, executionId: otherExecutionId }],
  openFolder = async () => {},
  deleteManagedWorktree = async () => true,
  payload = "{}"
} = {}) => {
  let result;
  const request = Readable.from(method === "POST" ? [payload] : []);
  request.method = method;
  request.headers = { "content-type": "application/json" };
  const handled = await handleRetainedWorkspaces({
    request,
    url: new URL(pathname),
    catalog: {
      list: () => records,
      read: (id) => records.find((item) => item.moveId === id) ?? null
    },
    validSession: () => authorized,
    validWrite: () => authorized,
    openFolder,
    deleteManagedWorktree,
    send: (status, body) => {
      result = { status, body };
    }
  });
  return { handled, ...result };
};

describe("retained workspace local gateway", () => {
  it("returns only matching execution locators after session validation", async () => {
    assert.deepEqual(await run({ authorized: false }), {
      handled: true,
      status: 403,
      body: { error: "forbidden" }
    });
    assert.deepEqual(await run(), {
      handled: true,
      status: 200,
      body: {
        workspaces: [
          {
            moveId,
            sourceProjectId: "lp_source",
            sourcePath: "/tmp/retained-worktree",
            reason: "changed",
            retainedAt: "2026-09-26T00:00:00.000Z",
            available: false,
            checkoutKind: "unknown",
            deletable: false
          }
        ]
      }
    });
  });

  it("opens only a matching catalog path with CSRF and an empty body", async () => {
    const opened = [];
    const pathname = `${base}/${moveId}/open`;
    assert.equal(
      (await run({ pathname, method: "POST", authorized: false })).status,
      403
    );
    assert.equal(
      (
        await run({
          pathname,
          method: "POST",
          payload: '{"path":"/tmp/elsewhere"}'
        })
      ).status,
      400
    );
    assert.deepEqual(
      await run({
        pathname,
        method: "POST",
        openFolder: async (path) => opened.push(path)
      }),
      { handled: true, status: 200, body: { opened: true } }
    );
    assert.deepEqual(opened, [record.sourcePath]);
    assert.equal(
      (
        await run({
          pathname,
          method: "POST",
          records: [{ ...record, executionId: otherExecutionId }]
        })
      ).status,
      404
    );
  });

  it("marks a real folder available and a symlink or missing folder unavailable", async () => {
    const folder = await mkdtemp(join(tmpdir(), "koed-retained-http-"));
    const link = `${folder}-link`;
    try {
      await symlink(folder, link);
      const canonicalFolder = await realpath(folder);
      const records = [
        { ...record, sourcePath: canonicalFolder },
        {
          ...record,
          moveId: "44444444-4444-4444-8444-444444444444",
          sourcePath: link
        },
        {
          ...record,
          moveId: "55555555-5555-4555-8555-555555555555",
          sourcePath: `${folder}-missing`
        }
      ];
      const result = await run({ records });
      assert.deepEqual(
        result.body.workspaces.map((item) => item.available),
        [true, false, false]
      );
    } finally {
      await rm(link, { force: true });
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("deletes only a matching managed record after an exact confirmation", async () => {
    const managed = {
      ...record,
      checkoutKind: "koed_managed_worktree",
      checkoutIdentity: {
        ownership: "koed_managed_worktree",
        canonicalPath: record.sourcePath
      }
    };
    const pathname = `${base}/${moveId}/delete`;
    const payload = '{"confirmation":"delete_managed_worktree"}';
    const deleted = [];
    const runDelete = (options = {}) =>
      run({
        pathname,
        method: "POST",
        payload,
        records: [managed],
        deleteManagedWorktree: async (id) => {
          deleted.push(id);
          return true;
        },
        ...options
      });
    assert.equal((await runDelete({ authorized: false })).status, 403);
    assert.equal((await runDelete({ payload: "{}" })).status, 400);
    assert.equal((await runDelete({ records: [record] })).status, 409);
    assert.equal(
      (
        await runDelete({
          records: [{ ...managed, executionId: otherExecutionId }]
        })
      ).status,
      404
    );
    assert.deepEqual(await runDelete(), {
      handled: true,
      status: 200,
      body: { deleted: true }
    });
    assert.deepEqual(deleted, [moveId]);
  });
});
