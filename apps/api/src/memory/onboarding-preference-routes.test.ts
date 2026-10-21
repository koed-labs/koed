import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  deleteDesktopLocalCredential,
  storeDesktopLocalCredential
} from "@koed/shared";
import { hqOnboardingPreferenceClaim } from "@koed/shared/hq-onboarding-contract";
import type { ApiRouteContext } from "../server/context.js";
import { routeIdentityFor } from "../server/route-identity.js";
import { registerOnboardingPreferenceRoutes } from "./onboarding-preference-routes.js";

const scratch = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scratch"
);
mkdirSync(scratch, { recursive: true });

describe("Desktop onboarding Me preference proposal", () => {
  const ownerId = randomUUID();
  const noteId = randomUUID();
  const memoryEventId = randomUUID();
  const proposalId = randomUUID();
  const claim = hqOnboardingPreferenceClaim("studying");
  const create = (home: string, profile = "local_personal") => {
    const app = Fastify();
    const note = {
      noteId,
      body: claim,
      memoryEventId,
      projectionState: "available"
    };
    const notes = {
      getPersonalNote: vi.fn(
        async (actor: { userId: string }, input: { noteId: string }) =>
          actor.userId === ownerId && input.noteId === noteId ? note : null
      )
    };
    const repository = {
      createOnboardingPreferenceProposal: vi.fn(async () => ({
        id: proposalId,
        status: "pending",
        assertionId: null
      }))
    };
    const context = {
      config: { deploymentProfile: profile, koedHome: home },
      auth: { authenticateSessionOrDeviceCredential: vi.fn() },
      requireRepository: () => repository,
      rateLimit: { memoryWrite: async () => undefined }
    } as unknown as ApiRouteContext;
    registerOnboardingPreferenceRoutes(app, context, notes as never);
    const send = (
      authorization: string,
      payload: Record<string, unknown> = {},
      remoteAddress = "127.0.0.1"
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/memory/curated/onboarding-preference",
        headers: { authorization },
        remoteAddress,
        payload: { role: "studying", noteId, memoryEventId, ...payload }
      });
    return { app, notes, note, repository, context, send };
  };

  it("requires both local owner families and the exact current Note/event", async () => {
    const home = mkdtempSync(join(scratch, "hq506-preference-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const fixture = create(home);
    try {
      const success = await fixture.send(credential.authorization);
      expect(success.statusCode).toBe(200);
      expect(success.json()).toEqual({
        proposalId,
        status: "pending",
        reviewedAssertionId: null
      });
      expect(
        fixture.repository.createOnboardingPreferenceProposal
      ).toHaveBeenCalledWith(
        { userId: ownerId },
        { noteId, memoryEventId, claim }
      );
      expect(
        (await fixture.send(credential.authorization, { role: "unknown" }))
          .statusCode
      ).toBe(400);
      expect(
        (
          await fixture.send(credential.authorization, {
            memoryEventId: randomUUID()
          })
        ).statusCode
      ).toBe(409);
      expect(
        (await fixture.send(credential.authorization, { noteId: randomUUID() }))
          .statusCode
      ).toBe(409);
      fixture.note.body = "Different claim";
      expect((await fixture.send(credential.authorization)).statusCode).toBe(
        409
      );
      expect(
        fixture.repository.createOnboardingPreferenceProposal
      ).toHaveBeenCalledTimes(1);
      expect((await fixture.send("Bearer personal-token")).statusCode).toBe(
        403
      );
      expect(
        (await fixture.send(credential.authorization, {}, "10.0.0.1"))
          .statusCode
      ).toBe(403);
      deleteDesktopLocalCredential(home);
      expect((await fixture.send(credential.authorization)).statusCode).toBe(
        401
      );
      expect(
        fixture.context.auth.authenticateSessionOrDeviceCredential
      ).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a missing family and nonlocal profile before reading evidence", async () => {
    for (const family of [
      "personal_collaboration_read",
      "personal_collaboration_write"
    ] as const) {
      const home = mkdtempSync(join(scratch, "hq506-preference-family-"));
      const credential = storeDesktopLocalCredential(home, {
        ownerUserId: ownerId,
        operationFamilies: [family]
      });
      const fixture = create(home);
      try {
        expect((await fixture.send(credential.authorization)).statusCode).toBe(
          401
        );
        expect(fixture.notes.getPersonalNote).not.toHaveBeenCalled();
      } finally {
        await fixture.app.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
    const home = mkdtempSync(join(scratch, "hq506-preference-remote-"));
    const credential = storeDesktopLocalCredential(home, {
      ownerUserId: ownerId,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    });
    const fixture = create(home, "team_self_hosted");
    try {
      expect((await fixture.send(credential.authorization)).statusCode).toBe(
        403
      );
      expect(fixture.notes.getPersonalNote).not.toHaveBeenCalled();
      expect(
        routeIdentityFor("POST", "/v1/memory/curated/onboarding-preference")
      ).toMatchObject({
        identity: "desktop_local_credential",
        deploymentModes: ["developer", "local_personal"]
      });
    } finally {
      await fixture.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
