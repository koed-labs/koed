import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDesktopLocalCredential } from "@koed/shared";
import { registerManagedTextActionRoutes } from "./text-action-routes.js";

const homes: string[] = [];
afterEach(() =>
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }))
);

const fixture = (profile = "local_personal", managedFamily = true) => {
  const home = mkdtempSync(join(tmpdir(), "hq504-routes-"));
  homes.push(home);
  const ownerUserId = randomUUID();
  const credential = storeDesktopLocalCredential(home, {
    ownerUserId,
    operationFamilies: managedFamily
      ? [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "managed_execution"
        ]
      : ["personal_collaboration_read", "personal_collaboration_write"]
  });
  const executionId = randomUUID();
  const action = {
    id: randomUUID(),
    ownerUserId,
    executionId,
    commandId: randomUUID(),
    state: "awaiting_review",
    revision: 1,
    name: "koed_project_create"
  };
  const repository = {
    enqueueManagedTextAction: vi.fn(async () => action),
    listManagedTextActions: vi.fn(async () => [action]),
    decideManagedTextAction: vi.fn(async () => ({
      ...action,
      state: "ready",
      revision: 2
    })),
    claimManagedTextAction: vi.fn(async () => ({
      ...action,
      state: "claimed",
      revision: 3
    })),
    completeManagedTextAction: vi.fn(async () => ({
      ...action,
      state: "applied",
      revision: 4
    })),
    prepareManagedTextTeamTodoAdd: vi.fn(
      async () => null as { action: typeof action; effectNonce: string } | null
    ),
    prepareManagedTextDeckMake: vi.fn(async () => null),
    markManagedTextDeckDispatch: vi.fn(async () => null),
    readManagedTextDeckEffectNonce: vi.fn(async () => null),
    reconcileManagedTextAction: vi.fn(async () => action)
  };
  const applyTeamTodoAdd = vi.fn(async () => undefined);
  const deckRepository = {
    getPersonalCreationLocation: vi.fn(async () => ({
      sourceDeckId: null,
      teamBackendId: null,
      workspaceProjectId: null
    })),
    getPersonalByCreationKey: vi.fn(async () => ({ id: randomUUID() }))
  };
  const createTeamDeck = vi.fn(
    async (input: {
      payload: {
        title: string;
        scope: string;
        madeFrom: string;
        cards: Array<{
          question: string;
          answer: string;
          sourceRef?: string | null;
          topicLabel?: string | null;
        }>;
      };
      workspaceProjectId: string;
    }) => ({
      id: randomUUID(),
      projectId: input.workspaceProjectId,
      title: input.payload.title,
      scope: input.payload.scope,
      madeFrom: input.payload.madeFrom,
      createdByAgentId: null,
      uses: 0,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cards: input.payload.cards.map((card) => ({
        id: randomUUID(),
        deckId: randomUUID(),
        question: card.question,
        answer: card.answer,
        sourceRef: card.sourceRef ?? null,
        topicLabel: card.topicLabel ?? null,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    })
  );
  const app = Fastify();
  registerManagedTextActionRoutes(app, {
    repository: repository as never,
    deckRepository: deckRepository as never,
    applyTeamTodoAdd,
    createTeamDeck,
    auth: {
      authenticateSessionOrDeviceCredential: vi.fn(async () => {
        throw new Error("browser/session fallback");
      })
    } as never,
    deploymentProfile: profile,
    koedHome: home,
    readRateLimit: async () => undefined,
    writeRateLimit: async () => undefined
  });
  const url = `/v1/managed-conversations/${executionId}/text-actions`;
  const body = {
    name: "koed_project_create",
    arguments: { name: "koed-main" },
    executionGeneration: 1,
    commandId: action.commandId,
    leaseToken: randomUUID(),
    providerTurnId: "turn-1",
    toolCallId: "call-1"
  };
  const post = (authorization = credential.authorization, extra = {}) =>
    app.inject({
      method: "POST",
      url,
      remoteAddress: "127.0.0.1",
      headers: { authorization },
      payload: { ...body, ...extra }
    });
  return {
    app,
    home,
    credential,
    executionId,
    action,
    repository,
    deckRepository,
    applyTeamTodoAdd,
    createTeamDeck,
    url,
    post
  };
};

describe("owner-local Koed text action admission", () => {
  it("never adopts a same-key Personal Deck after a Team-generated Project leaves", async () => {
    const f = fixture();
    try {
      const projectId = randomUUID();
      f.repository.reconcileManagedTextAction.mockResolvedValueOnce({
        ...f.action,
        name: "koed_deck_make",
        state: "applied",
        arguments: {
          projectId,
          title: "Chapter 7",
          scope: "Midterm",
          madeFrom: "Notes",
          cards: [{ question: "Q?", answer: "A." }]
        },
        snapshot: {
          projectId,
          workspaceProjectId: randomUUID(),
          teamBackendId: "old-team"
        }
      } as never);
      const result = await f.app.inject({
        method: "GET",
        url: `${f.url}/${f.action.id}/deck-result`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization }
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ state: "applied", result: null });
      expect(f.deckRepository.getPersonalByCreationKey).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
  });
  it("applies linked flashcards with a strict Team payload and reviewed device snapshot", async () => {
    const f = fixture();
    try {
      const personalProjectId = randomUUID();
      const workspaceProjectId = randomUUID();
      const runnerDeviceId = randomUUID();
      const generated = {
        ...f.action,
        name: "koed_deck_make",
        state: "claimed",
        revision: 3,
        arguments: {
          projectId: personalProjectId,
          title: "Chapter 7",
          scope: "Only exam material",
          madeFrom: "Notes",
          cards: [{ question: "Q?", answer: "A.", sourceRef: "Notes p. 7" }]
        },
        snapshot: {
          projectId: personalProjectId,
          agentId: randomUUID(),
          workspaceProjectId,
          teamBackendId: "team-vps",
          runnerDeviceId,
          teamProjectVersion: 7,
          teamMemberVersion: 3
        }
      };
      f.repository.prepareManagedTextDeckMake.mockResolvedValueOnce(
        generated as never
      );
      f.repository.markManagedTextDeckDispatch.mockResolvedValueOnce({
        action: generated,
        effectNonce: "A".repeat(43)
      } as never);
      const response = await f.app.inject({
        method: "POST",
        url: `${f.url}/${f.action.id}/apply-deck-make`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization },
        payload: { expectedRevision: 3 }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.projectId).toBe(personalProjectId);
      expect(f.createTeamDeck).toHaveBeenCalledWith(
        expect.objectContaining({
          runnerDeviceId,
          workspaceProjectId,
          payload: {
            idempotencyKey: f.action.id,
            title: "Chapter 7",
            scope: "Only exam material",
            madeFrom: "Notes",
            cards: [{ question: "Q?", answer: "A.", sourceRef: "Notes p. 7" }]
          }
        })
      );
      expect(f.createTeamDeck.mock.calls[0]?.[0].payload).not.toHaveProperty(
        "createdByAgentId"
      );
    } finally {
      await f.app.close();
    }
  });
  it("does not contact Team without the claimed exact Personal action", async () => {
    const f = fixture();
    const url = `${f.url}/${f.action.id}/apply-team-todo-add`;
    try {
      const body = { expectedRevision: 3 };
      expect(
        (
          await f.app.inject({
            method: "POST",
            url,
            payload: body,
            remoteAddress: "127.0.0.1",
            headers: { authorization: f.credential.authorization }
          })
        ).statusCode
      ).toBe(409);
      expect(f.applyTeamTodoAdd).not.toHaveBeenCalled();
      f.repository.prepareManagedTextTeamTodoAdd.mockResolvedValueOnce({
        effectNonce: "a".repeat(43),
        action: {
          ...f.action,
          state: "claimed",
          revision: 3,
          name: "koed_todo_add",
          arguments: { projectId: randomUUID(), title: "Call" },
          snapshot: {
            teamBackendId: "team",
            workspaceProjectId: randomUUID(),
            teamProjectVersion: 4,
            teamMemberVersion: 2
          }
        }
      } as never);
      const applied = await f.app.inject({
        method: "POST",
        url,
        payload: body,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization }
      });
      expect(applied.statusCode).toBe(200);
      expect(f.applyTeamTodoAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: f.action.ownerUserId,
          actionId: f.action.id,
          title: "Call",
          goal: "Call",
          expectedProjectVersion: 4,
          expectedMemberVersion: 2
        })
      );
    } finally {
      await f.app.close();
    }
  });
  it("accepts an exact typed leased proposal and owner-scoped review/claim", async () => {
    const f = fixture();
    try {
      expect((await f.post()).statusCode).toBe(202);
      expect(f.repository.enqueueManagedTextAction).toHaveBeenCalledWith(
        { userId: f.action.ownerUserId },
        expect.objectContaining({
          executionId: f.executionId,
          commandId: f.action.commandId,
          arguments: { name: "koed-main" }
        })
      );
      const list = await f.app.inject({
        method: "GET",
        url: f.url,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization }
      });
      expect(list.json().actions).toHaveLength(1);
      const reviewed = await f.app.inject({
        method: "POST",
        url: `${f.url}/${f.action.id}/review`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization },
        payload: { expectedRevision: 1, decision: "approve" }
      });
      expect(reviewed.json().action.state).toBe("ready");
      const claimed = await f.app.inject({
        method: "POST",
        url: `${f.url}/${f.action.id}/claim`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization },
        payload: { expectedRevision: 2 }
      });
      expect(claimed.json().action.state).toBe("claimed");
      const completed = await f.app.inject({
        method: "POST",
        url: `${f.url}/${f.action.id}/complete`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: f.credential.authorization },
        payload: { expectedRevision: 3 }
      });
      expect(completed.json().action.state).toBe("applied");
    } finally {
      await f.app.close();
    }
  });

  it("denies generic tokens, remote Desktop, missing managed family, and extra owner claims", async () => {
    const f = fixture();
    try {
      expect((await f.post("Bearer fake")).statusCode).toBe(403);
      expect(
        (
          await f.post(f.credential.authorization, {
            ownerUserId: randomUUID()
          })
        ).statusCode
      ).toBe(400);
      const remote = await f.app.inject({
        method: "POST",
        url: f.url,
        remoteAddress: "203.0.113.8",
        headers: { authorization: f.credential.authorization },
        payload: {
          name: "koed_project_create",
          arguments: { name: "x" },
          executionGeneration: 1,
          commandId: f.action.commandId,
          leaseToken: randomUUID(),
          providerTurnId: "turn",
          toolCallId: "call"
        }
      });
      expect(remote.statusCode).toBe(403);
      expect(f.repository.enqueueManagedTextAction).not.toHaveBeenCalled();
    } finally {
      await f.app.close();
    }
    const withoutManaged = fixture("local_personal", false);
    try {
      expect((await withoutManaged.post()).statusCode).toBe(403);
      expect(
        withoutManaged.repository.enqueueManagedTextAction
      ).not.toHaveBeenCalled();
    } finally {
      await withoutManaged.app.close();
    }
  });
});
