import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer } from "./index.mjs";

const executionId = "11111111-1111-4111-8111-111111111111";
const moveId = "22222222-2222-4222-8222-222222222222";

describe("local retained workspace route", () => {
  it("requires a Studio session and never forwards the local path", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "studio-retained-route-"));
    await writeFile(join(staticDir, "index.html"), "test");
    const calls = [];
    const opened = [];
    const record = {
      moveId,
      executionId,
      sourceProjectId: "lp_source",
      sourcePath: "/tmp/local-retained-worktree",
      reason: "changed",
      retainedAt: "2026-09-26T00:00:00.000Z"
    };
    const server = await startStudioServer({
      port: 0,
      staticDir,
      token: "test-secret",
      fetchImpl: async (...args) => {
        calls.push(args);
        return new Response("{}", { status: 200 });
      },
      retainedWorkspaceCatalog: {
        list: () => [record],
        read: (id) => (id === moveId ? record : null)
      },
      openRetainedWorkspaceFolder: async (path) => opened.push(path)
    });
    try {
      const endpoint = `${server.url}/studio-api/managed-conversations/${executionId}/retained-workspaces`;
      assert.equal((await fetch(endpoint)).status, 403);
      const session = await (
        await fetch(`${server.url}/studio-api/github/session`)
      ).json();
      const response = await fetch(endpoint, {
        headers: { "x-studio-csrf": session.csrfToken }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        workspaces: [
          {
            moveId,
            sourceProjectId: "lp_source",
            sourcePath: record.sourcePath,
            reason: "changed",
            retainedAt: record.retainedAt,
            available: false,
            checkoutKind: "unknown",
            deletable: false
          }
        ]
      });
      const openedResponse = await fetch(`${endpoint}/${moveId}/open`, {
        method: "POST",
        headers: {
          origin: server.url,
          "x-studio-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: "{}"
      });
      assert.equal(openedResponse.status, 200);
      assert.deepEqual(opened, [record.sourcePath]);
      assert.deepEqual(calls, []);
    } finally {
      await server.close();
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
