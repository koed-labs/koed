import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { WorkItemConflictError } from "@koed/db";
import { describe, expect, it, vi } from "vitest";
import { registerWorkItemsFromDocumentRoutes } from "./from-document-routes.js";

const owner = randomUUID();
vi.mock("../projects/desktop-read-auth.js", () => ({
  authenticateProjectOperation: vi.fn(async () => ({ id: owner }))
}));
vi.mock("@koed/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@koed/shared")>()),
  verifyDesktopLocalCredentialAuthorization: vi.fn(() => ({
    ownerUserId: owner
  }))
}));

const fixture = () => {
  const executionId = randomUUID();
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const commandId = randomUUID();
  const leaseToken = randomUUID();
  const execution = {
    id: executionId,
    ownerUserId: owner,
    projectId,
    executionGeneration: 1,
    state: "running"
  };
  const command = {
    id: commandId,
    ownerUserId: owner,
    executionId,
    executionGeneration: 1,
    commandKind: "prompt",
    state: "dispatching",
    leaseToken,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    payload: {} as Record<string, unknown>
  };
  const managed = {
    getManagedConversationExecution: vi.fn(async () => execution),
    getLatestManagedConversationCommandForExecution: vi.fn(async () => ({
      ...command
    }))
  };
  const source = {
    sourceId,
    sourceRevisionId: randomUUID(),
    noteRevisionId: randomUUID(),
    name: "Syllabus.txt",
    text: "Seminar paper due 22 Oct 2026\nPrepare lab report by 30 Oct 2026"
  };
  const documents: Array<{
    id: string;
    kind: string;
    status: string;
    name: string;
    currentRevisionId: string | null;
    deletedAt: null;
  }> = [
    {
      id: sourceId,
      kind: "doc",
      status: "ready",
      name: source.name,
      currentRevisionId: source.noteRevisionId,
      deletedAt: null
    }
  ];
  const sources = {
    readDocument: vi.fn(async () => source),
    list: vi.fn(async () => documents)
  };
  const items = {
    previewFromDocument: vi.fn(async () => ({
      newCount: 1,
      alreadyExistingCount: 0,
      removedCount: 0,
      candidates: [
        { lineNumber: 1, title: "Write seminar paper", status: "new" }
      ]
    })),
    createFromDocument: vi.fn(async () => ({
      items: [],
      created: 0,
      alreadyExisting: 0
    }))
  };
  const app = Fastify();
  registerWorkItemsFromDocumentRoutes(app, {
    managed,
    sources,
    items,
    auth: {} as never,
    deploymentProfile: "developer",
    koedHome: "/tmp/koed-test",
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  } as never);
  const path = `/v1/managed-conversations/${executionId}/work-items-from-doc`;
  const read = (
    cursor = 0,
    generation = 1,
    authorization = "Koed-Desktop test"
  ) =>
    app.inject({
      method: "GET",
      url: `${path}/read?sourceId=${sourceId}&cursor=${cursor}&executionGeneration=${generation}`,
      headers: { authorization }
    });
  const list = (
    cursor = 0,
    generation = 1,
    authorization = "Koed-Desktop test"
  ) =>
    app.inject({
      method: "GET",
      url: `${path}/list?cursor=${cursor}&executionGeneration=${generation}`,
      headers: { authorization }
    });
  return {
    app,
    path,
    read,
    list,
    documents,
    execution,
    command,
    source,
    sources,
    items,
    managed
  };
};

describe("managed document read and apply authority", () => {
  it("lets catch-up inspect a document but reserves apply for a User start or prompt", async () => {
    const f = fixture();
    f.command.commandKind = "hq_catch_up";
    expect((await f.list()).statusCode).toBe(200);
    expect((await f.read()).statusCode).toBe(200);
    const preview = await f.app.inject({
      method: "POST",
      url: `${f.path}/preview`,
      headers: { authorization: "Koed-Desktop test" },
      payload: {
        executionGeneration: 1,
        sourceId: f.source.sourceId,
        sourceRevisionId: f.source.sourceRevisionId,
        noteRevisionId: f.source.noteRevisionId,
        proposals: [
          {
            lineNumber: 1,
            sourceLine: "Seminar paper due 22 Oct 2026",
            title: "Write seminar paper",
            goal: "Submit the paper",
            dueText: "22 Oct 2026"
          }
        ]
      }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().newCount).toBe(1);
    expect(f.items.previewFromDocument).toHaveBeenCalledOnce();
    expect(f.items.createFromDocument).not.toHaveBeenCalled();
    const body = {
      commandId: f.command.id,
      leaseToken: f.command.leaseToken,
      executionGeneration: 1,
      sourceId: f.source.sourceId,
      sourceRevisionId: f.source.sourceRevisionId,
      noteRevisionId: f.source.noteRevisionId,
      timeZone: "Europe/Oslo",
      proposals: [
        {
          lineNumber: 1,
          sourceLine: "Seminar paper due 22 Oct 2026",
          title: "Write seminar paper",
          goal: "Submit the paper",
          dueText: "22 Oct 2026"
        }
      ]
    };
    const denied = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: body
    });
    expect(denied.statusCode).toBe(409);
    expect(f.items.createFromDocument).not.toHaveBeenCalled();
    f.command.commandKind = "start";
    const firstUser = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: body
    });
    expect(firstUser.statusCode).toBe(200);
    expect(f.items.createFromDocument).toHaveBeenCalledOnce();
    await f.app.close();
  });

  it("lists bounded current document metadata for typed requests, without Source text", async () => {
    const f = fixture();
    for (let index = 0; index < 31; index++)
      f.documents.push({
        id: randomUUID(),
        kind: "doc",
        status: "ready",
        name: `Document ${index}`,
        currentRevisionId: randomUUID(),
        deletedAt: null
      });
    f.documents.push({
      id: randomUUID(),
      kind: "repo",
      status: "ready",
      name: "Repository",
      currentRevisionId: null,
      deletedAt: null
    });
    const first = await f.list();
    expect(first.statusCode).toBe(200);
    expect(first.json().documents).toHaveLength(30);
    expect(first.json().nextCursor).toBe(30);
    expect(first.body).not.toContain("Seminar paper");
    expect(first.body).not.toContain("Repository");
    const last = await f.list(30);
    expect(last.json().documents).toHaveLength(2);
    expect(last.json().nextCursor).toBeNull();
    expect(f.sources.readDocument).not.toHaveBeenCalled();
    await f.app.close();
  });

  it("withholds a preview when the selected Source, revision, or command lease changes", async () => {
    const f = fixture();
    const payload = () => ({
      executionGeneration: 1,
      sourceId: f.source.sourceId,
      sourceRevisionId: f.source.sourceRevisionId,
      noteRevisionId: f.source.noteRevisionId,
      proposals: [
        {
          lineNumber: 1,
          sourceLine: "Seminar paper due 22 Oct 2026",
          title: "Write seminar paper",
          goal: "Submit the paper",
          dueText: "22 Oct 2026"
        }
      ]
    });
    const preview = (body = payload()) =>
      f.app.inject({
        method: "POST",
        url: `${f.path}/preview`,
        headers: { authorization: "Koed-Desktop test" },
        payload: body
      });
    f.command.payload.selectedDocumentSourceId = randomUUID();
    expect((await preview()).statusCode).toBe(409);
    expect(f.sources.readDocument).not.toHaveBeenCalled();
    f.command.payload.selectedDocumentSourceId = f.source.sourceId;
    expect(
      (await preview({ ...payload(), noteRevisionId: randomUUID() })).statusCode
    ).toBe(409);
    expect(f.items.previewFromDocument).not.toHaveBeenCalled();
    f.items.previewFromDocument.mockImplementationOnce(async () => {
      f.command.leaseToken = randomUUID();
      return {
        newCount: 1,
        alreadyExistingCount: 0,
        removedCount: 0,
        candidates: [
          { lineNumber: 1, title: "Write seminar paper", status: "new" }
        ]
      };
    });
    const stale = await preview();
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain("Write seminar paper");
    await f.app.close();
  });

  it("restricts selected discovery to one Source and denies changed lease or generation", async () => {
    const f = fixture();
    f.documents.push({
      id: randomUUID(),
      kind: "doc",
      status: "ready",
      name: "Other.txt",
      currentRevisionId: randomUUID(),
      deletedAt: null
    });
    f.command.payload.selectedDocumentSourceId = f.source.sourceId;
    expect((await f.list()).json().documents).toEqual([
      {
        sourceId: f.source.sourceId,
        name: f.source.name,
        noteRevisionId: f.source.noteRevisionId
      }
    ]);
    expect((await f.list(0, 2)).statusCode).toBe(409);
    expect((await f.list(0, 1, "Bearer token")).statusCode).toBe(403);
    f.sources.list.mockImplementationOnce(async () => {
      f.command.leaseToken = randomUUID();
      return f.documents;
    });
    const stale = await f.list();
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain("Syllabus.txt");
    await f.app.close();
  });

  it("pages exact Note lines and withholds them if the lease changes during decryption", async () => {
    const f = fixture();
    const first = await f.read();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      sourceRevisionId: f.source.sourceRevisionId,
      lines: [
        { lineNumber: 1, text: "Seminar paper due 22 Oct 2026" },
        { lineNumber: 2, text: "Prepare lab report by 30 Oct 2026" }
      ],
      remaining: false
    });
    f.sources.readDocument.mockImplementationOnce(async () => {
      f.command.leaseToken = randomUUID();
      return f.source;
    });
    const stale = await f.read();
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain("Seminar paper");
    await f.app.close();
  });

  it("denies absent Desktop credential, changed generation and stopped command before Source read", async () => {
    const f = fixture();
    expect((await f.read(0, 1, "Bearer personal-token")).statusCode).toBe(403);
    expect((await f.read(0, 2)).statusCode).toBe(409);
    f.command.state = "completed";
    expect((await f.read()).statusCode).toBe(409);
    expect(f.sources.readDocument).not.toHaveBeenCalled();
    await f.app.close();
  });
  it("binds an HQ selected document separately from the visible prompt", async () => {
    const f = fixture();
    f.command.payload.selectedDocumentSourceId = f.source.sourceId;
    const selected = await f.app.inject({
      method: "GET",
      url: `${f.path}/read?executionGeneration=1`,
      headers: { authorization: "Koed-Desktop test" }
    });
    expect(selected.statusCode).toBe(200);
    expect(f.sources.readDocument).toHaveBeenCalledWith(
      owner,
      f.execution.projectId,
      f.source.sourceId
    );
    const otherSourceId = randomUUID();
    const forged = await f.app.inject({
      method: "GET",
      url: `${f.path}/read?sourceId=${otherSourceId}&executionGeneration=1`,
      headers: { authorization: "Koed-Desktop test" }
    });
    expect(forged.statusCode).toBe(409);
    expect(f.sources.readDocument).toHaveBeenCalledTimes(1);
    const deniedApply = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: {
        commandId: f.command.id,
        leaseToken: f.command.leaseToken,
        executionGeneration: 1,
        sourceId: otherSourceId,
        sourceRevisionId: f.source.sourceRevisionId,
        noteRevisionId: f.source.noteRevisionId,
        timeZone: "Europe/Oslo",
        proposals: [
          {
            lineNumber: 1,
            sourceLine: "Seminar paper due 22 Oct 2026",
            title: "Write seminar paper",
            goal: "Submit the paper",
            dueText: "22 Oct 2026"
          }
        ]
      }
    });
    expect(deniedApply.statusCode).toBe(409);
    expect(f.items.createFromDocument).not.toHaveBeenCalled();
    await f.app.close();
  });
  it("reports every page and refuses unrepresentable evidence before showing a partial document", async () => {
    const f = fixture();
    f.source.text = Array.from(
      { length: 230 },
      (_, index) => `Task ${index + 1}`
    ).join("\n");
    const first = (await f.read()).json();
    expect(first.lines).toHaveLength(200);
    expect(first.nextCursor).toBe(200);
    expect(first.remaining).toBe(true);
    const last = (await f.read(200)).json();
    expect(last.lines).toHaveLength(30);
    expect(last.nextCursor).toBeNull();
    f.source.text = `Task 1\n${"x".repeat(4_001)}`;
    const tooLong = await f.read();
    expect(tooLong.statusCode).toBe(413);
    expect(tooLong.body).not.toContain("Task 1");
    await f.app.close();
  });

  it("passes only a current exact proposal batch to the repository", async () => {
    const f = fixture();
    const body = {
      commandId: f.command.id,
      leaseToken: f.command.leaseToken,
      executionGeneration: 1,
      sourceId: f.source.sourceId,
      sourceRevisionId: f.source.sourceRevisionId,
      noteRevisionId: f.source.noteRevisionId,
      timeZone: "Europe/Oslo",
      proposals: [
        {
          lineNumber: 1,
          sourceLine: "Seminar paper due 22 Oct 2026",
          title: "Write seminar paper",
          goal: "Submit the paper",
          dueText: "22 Oct 2026"
        }
      ]
    };
    const accepted = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: body
    });
    expect(accepted.statusCode).toBe(200);
    expect(f.items.createFromDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: owner,
        projectId: f.execution.projectId,
        proposals: [
          expect.objectContaining({
            sourceLine: body.proposals[0]!.sourceLine,
            dueOn: "2026-10-22"
          })
        ]
      })
    );
    const forged = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: {
        ...body,
        proposals: [{ ...body.proposals[0], dueText: "invented" }]
      }
    });
    expect(forged.statusCode).toBe(409);
    expect(f.items.createFromDocument).toHaveBeenCalledTimes(1);
    f.items.createFromDocument.mockRejectedValueOnce(
      new WorkItemConflictError("Agent command is busy", null)
    );
    const busy = await f.app.inject({
      method: "POST",
      url: `${f.path}/apply`,
      headers: { authorization: "Koed-Desktop test" },
      payload: body
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.body).toContain("Agent command is busy");
    await f.app.close();
  });
});
