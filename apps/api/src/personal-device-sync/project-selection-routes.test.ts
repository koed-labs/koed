import Fastify from "fastify";
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  signPdsProjectSelection,
  PDS_PROJECT_SELECTION_PROTOCOL
} from "@koed/shared";
import { registerPersonalDeviceSyncRoutes } from "./routes.js";
import type { ApiRouteContext } from "../server/context.js";

const scope = {
  groupId: "group",
  associationId: "association",
  selectionId: "selection"
};
const fixture = async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(
        error instanceof ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 500)
      )
      .send({ error: error instanceof Error ? error.message : "error" })
  );
  const state = {
    state: "selected",
    heads: ["r1"],
    revisions: [],
    anchorFingerprint: "gr_project"
  };
  const journal = {
    read: vi.fn().mockResolvedValue(state),
    readAccepted: vi.fn().mockResolvedValue({ ...scope, state }),
    listAssociations: vi.fn().mockResolvedValue([]),
    accept: vi.fn().mockResolvedValue(state),
    forgetAcceptance: vi.fn().mockResolvedValue(undefined),
    appendVerified: vi.fn().mockResolvedValue({ inserted: true, state })
  };
  const key = generateKeyPairSync("ed25519").privateKey;
  const signer = vi.fn((input) =>
    signPdsProjectSelection(
      {
        ...input,
        protocol: PDS_PROJECT_SELECTION_PROTOCOL,
        groupId: "group",
        authorDeviceId: "device",
        authorSigningKeyId: "device_key"
      },
      key
    )
  );
  const context = {
    requireRepository: () => ({ personalProjectSelections: journal }),
    rateLimit: {
      memoryRead: async () => undefined,
      memoryWrite: async () => undefined
    },
    auth: {
      authenticate: async () => ({ id: "owner" }),
      authenticateSession: async () => ({ id: "owner" })
    },
    personalDeviceSync: {
      authoritySigner: null,
      secureKeyProvider: {
        getSourceContext: async (input: { groupId: string; userId: string }) =>
          input.groupId === "group" && input.userId === "owner"
            ? { signProjectSelection: signer }
            : null
      }
    }
  } as unknown as ApiRouteContext;
  registerPersonalDeviceSyncRoutes(app, context);
  await app.ready();
  return { app, journal, signer };
};
it("denies API Token governance while allowing the owner's bounded capture lookup", async () => {
  const { app, journal } = await fixture();
  try {
    for (const request of [
      {
        method: "GET" as const,
        url: "/v1/pds/project-associations?groupId=group"
      },
      {
        method: "POST" as const,
        url: "/v1/pds/project-associations/accept",
        payload: {}
      },
      {
        method: "POST" as const,
        url: "/v1/pds/project-selections",
        payload: {}
      }
    ])
      expect(
        (
          await app.inject({
            ...request,
            headers: { authorization: "Bearer token" }
          })
        ).statusCode
      ).toBe(403);
    expect(journal.listAssociations).not.toHaveBeenCalled();
    expect(journal.appendVerified).not.toHaveBeenCalled();
    const read = await app.inject({
      method: "GET",
      url: "/v1/memory/repository-selection?originatingDeviceId=profile&checkoutId=checkout",
      headers: { authorization: "Bearer token" }
    });
    expect(read.statusCode).toBe(200);
    expect(journal.readAccepted).toHaveBeenCalledWith({
      userId: "owner",
      originatingDeviceId: "profile",
      checkoutId: "checkout"
    });
    expect(read.json()).toEqual({
      association: {
        ...scope,
        selection: { state: "selected", anchorFingerprint: "gr_project" }
      }
    });
    expect(read.body).not.toContain("revisions");
  } finally {
    await app.close();
  }
});
it("signs exactly reviewed heads, rejects injected authors, and returns stale-review conflicts", async () => {
  const { app, journal, signer } = await fixture();
  const payload = {
    ...scope,
    reviewedHeads: ["rA", "rB"],
    operation: { kind: "delete" }
  };
  try {
    const written = await app.inject({
      method: "POST",
      url: "/v1/pds/project-selections",
      payload
    });
    expect(written.statusCode).toBe(200);
    expect(journal.appendVerified).toHaveBeenLastCalledWith({
      userId: "owner",
      record: expect.objectContaining({
        revision: expect.objectContaining({
          ...scope,
          authorDeviceId: "device",
          replaces: ["rA", "rB"]
        })
      }),
      reviewedHeads: ["rA", "rB"]
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pds/project-selections",
          payload: { ...payload, authorDeviceId: "other" }
        })
      ).statusCode
    ).toBe(400);
    expect(signer).toHaveBeenCalledTimes(1);
    journal.appendVerified.mockRejectedValueOnce(
      new Error("Project selection changed; review its current revisions")
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pds/project-selections",
          payload
        })
      ).statusCode
    ).toBe(409);
    const count = signer.mock.calls.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pds/project-selections",
          payload: { ...payload, groupId: "other" }
        })
      ).statusCode
    ).toBe(503);
    expect(signer).toHaveBeenCalledTimes(count);
  } finally {
    await app.close();
  }
});
