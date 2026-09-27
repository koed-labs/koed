import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStudioServer } from "./index.mjs";

const id = `lp_${"a".repeat(32)}`;
const metadata = {
  localProjectId: id,
  displayName: "An empty project",
  lastSeenAt: "2026-09-25T12:00:00.000Z"
};

describe("Studio local Project bridge", () => {
  let started;
  afterEach(async () => {
    await started?.close();
    started = undefined;
  });

  it("lists registered projects without requiring conversations", async () => {
    started = await startStudioServer({
      port: 0,
      listProjects: async () => ({ ok: true, projects: [metadata] })
    });
    const response = await fetch(`${started.url}/studio-api/projects`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      projects: [{ id, name: "An empty project", lastSeenAt: metadata.lastSeenAt }]
    });
    const capabilities = await fetch(`${started.url}/studio-api/projects/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.deepEqual(await capabilities.json(), { canCreateLocalProject: false });
  });

  it("requires a same-origin CSRF session and a chosen folder before registration", async () => {
    let registerCalls = 0;
    started = await startStudioServer({
      port: 0,
      listProjects: async () => ({ ok: true, projects: [] }),
      chooseProjectDirectory: async () => "/tmp/selected-project",
      registerProject: async ({ path, name }) => {
        registerCalls += 1;
        assert.equal(path, "/tmp/selected-project");
        assert.equal(name, "My project");
        return { ok: true, project: { ...metadata, displayName: name } };
      }
    });
    const post = (path, body, csrfToken) => fetch(`${started.url}${path}`, {
      method: "POST",
      headers: {
        origin: started.url,
        "content-type": "application/json",
        ...(csrfToken ? { "x-studio-csrf": csrfToken } : {})
      },
      body: JSON.stringify(body)
    });
    const withoutCsrf = await post("/studio-api/projects/choose-folder", {});
    assert.equal(withoutCsrf.status, 403);
    assert.equal(registerCalls, 0);
    const capabilities = await fetch(`${started.url}/studio-api/projects/capabilities`);
    assert.deepEqual(await capabilities.json(), { canCreateLocalProject: true });

    const sessionResponse = await fetch(`${started.url}/studio-api/projects/session`);
    assert.equal(sessionResponse.status, 200);
    const { csrfToken } = await sessionResponse.json();
    const withoutSelection = await post("/studio-api/projects", {
      name: "My project", selectionId: "b".repeat(32)
    }, csrfToken);
    assert.equal(withoutSelection.status, 400);
    assert.equal(registerCalls, 0);

    const chosen = await post("/studio-api/projects/choose-folder", {}, csrfToken);
    assert.equal(chosen.status, 200);
    const selection = await chosen.json();
    assert.equal(selection.canceled, false);
    const created = await post("/studio-api/projects", {
      name: "My project", selectionId: selection.selectionId
    }, csrfToken);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).project.name, "My project");
    assert.equal(registerCalls, 1);
    const replay = await post("/studio-api/projects", {
      name: "My project", selectionId: selection.selectionId
    }, csrfToken);
    assert.equal(replay.status, 400);
    assert.equal(registerCalls, 1);
  });

  it("does not register when the native folder picker is canceled", async () => {
    let registerCalls = 0;
    started = await startStudioServer({
      port: 0,
      chooseProjectDirectory: async () => null,
      registerProject: async () => { registerCalls += 1; }
    });
    const { csrfToken } = await (await fetch(`${started.url}/studio-api/projects/session`)).json();
    const response = await fetch(`${started.url}/studio-api/projects/choose-folder`, {
      method: "POST",
      headers: { origin: started.url, "content-type": "application/json", "x-studio-csrf": csrfToken },
      body: "{}"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { canceled: true });
    assert.equal(registerCalls, 0);
  });
});
