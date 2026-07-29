import type {
  DeviceCredentialAuthContext,
  LegalHoldRecord,
  RetentionLifecycleRepository,
  UserRecord
} from "@koed/db";
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  registerRetentionRoutes,
  retentionAdminRequestHash,
  retentionAdminScopeHash
} from "./routes.js";

const user: UserRecord = {
  id: randomUUID(),
  email: "retention-owner@example.test",
  displayName: "Retention Owner",
  passwordHash: null
};

const secondUser: UserRecord = {
  id: randomUUID(),
  email: "retention-admin@example.test",
  displayName: "Retention Admin",
  passwordHash: null
};

const teamId = randomUUID();
const holdId = randomUUID();
const policyId = randomUUID();
const previewId = randomUUID();
const ownerPrivateReplicaId = randomUUID();
const logicalMemoryId = randomUUID();
const now = () => new Date().toISOString();
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const hold = (overrides: Partial<LegalHoldRecord> = {}): LegalHoldRecord => ({
  id: holdId,
  target: { scope: "team", teamId },
  authority: "team.legal_hold.manage",
  reasonCode: "matter.open",
  reasonHash: hash("matter open"),
  state: "active",
  placedByUserId: user.id,
  freshlyAuthenticatedAt: new Date(),
  placedAt: new Date(),
  releaseRequestedByUserId: null,
  releaseRequestedAt: null,
  releaseConfirmedByUserId: null,
  releaseConfirmedAt: null,
  singleHolderReleaseException: false,
  releasedAt: null,
  ...overrides
});

const deviceAuth = (): DeviceCredentialAuthContext => ({
  user,
  credential: {
    id: randomUUID(),
    ownerUserId: user.id,
    enrollmentChallengeId: null,
    credentialKeyId: "device-key",
    upstreamBackendId: "backend-1",
    deviceInstanceId: "device-1",
    lineageId: randomUUID(),
    deviceLabel: "Retention device",
    credentialVersion: 1,
    verifierKind: "secret_hash",
    operationFamilies: ["action_grant"],
    metadata: {},
    createdAt: now(),
    updatedAt: now(),
    lastUsedAt: null,
    lastValidatedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revocationReason: null
  }
});

const createFixture = async (input?: {
  sessionUser?: UserRecord;
  sessionCreatedAt?: Date;
  retentionRepository?: Partial<RetentionLifecycleRepository>;
  highRiskRepository?: {
    executeActionGrant?: ReturnType<typeof vi.fn>;
    lookupLegalHoldTeamId?: ReturnType<typeof vi.fn>;
  };
}) => {
  const retentionRepository = {
    versionPolicy: vi.fn(async () => ({
      id: randomUUID(),
      policyId,
      version: 2
    })),
    previewPolicyShortening: vi.fn(async () => ({
      id: previewId,
      teamId,
      policyId,
      policyVersion: 2,
      previewedByUserId: user.id,
      previewedAt: new Date(),
      graceUntil: new Date(Date.now() + 60_000),
      previewHash: hash("policy preview"),
      affectedScopes: []
    })),
    confirmPolicyShortening: vi.fn(async () => ({
      id: randomUUID(),
      previewId,
      previewHash: hash("policy preview"),
      confirmedByUserId: user.id,
      confirmedAt: new Date(),
      migratedDecisionIds: []
    })),
    requestRootTeamDeletion: vi.fn(async () => ({
      team: {
        id: teamId,
        name: "Retention Team",
        version: 2,
        lifecycle: "deletion_requested",
        deletionRequestedAt: new Date(),
        tombstonedAt: new Date(),
        retainUntil: new Date(),
        purgeCompletedAt: null
      },
      decision: { id: randomUUID() },
      purgeJob: { id: randomUUID(), state: "pending" },
      requiredArtifacts: []
    })),
    listOwnerPrivateReplicasForUserErasure: vi.fn(async () => [
      { id: ownerPrivateReplicaId, logicalMemoryId, version: 1 }
    ]),
    requestOwnerPrivateReplicaPurge: vi.fn(async () => ({
      ownerPrivateReplica: { id: ownerPrivateReplicaId },
      decision: { id: randomUUID(), trigger: "source_purge" },
      purgeJob: { id: randomUUID(), state: "pending" },
      requiredArtifacts: []
    })),
    completeUserErasureTombstone: vi.fn(async () => ({
      userId: user.id,
      erasedAt: new Date()
    })),
    placeLegalHold: vi.fn(async () => hold()),
    requestLegalHoldRelease: vi.fn(async () =>
      hold({
        state: "release_pending",
        releaseRequestedByUserId: user.id,
        releaseRequestedAt: new Date()
      })
    ),
    confirmLegalHoldRelease: vi.fn(async () =>
      hold({
        state: "released",
        releaseRequestedByUserId: user.id,
        releaseRequestedAt: new Date(),
        releaseConfirmedByUserId: secondUser.id,
        releaseConfirmedAt: new Date(),
        releasedAt: new Date()
      })
    ),
    ...input?.retentionRepository
  } as unknown as RetentionLifecycleRepository;
  const executeActionGrant =
    input?.highRiskRepository?.executeActionGrant ??
    vi.fn(
      async (grantInput: {
        execute: (repositories: {
          retention: RetentionLifecycleRepository;
        }) => Promise<unknown>;
      }) => grantInput.execute({ retention: retentionRepository })
    );
  const lookupLegalHoldTeamId =
    input?.highRiskRepository?.lookupLegalHoldTeamId ??
    vi.fn(async () => teamId);
  const auth = deviceAuth();
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : error instanceof z.ZodError
          ? 400
          : 500;
    reply.status(statusCode).send({
      error:
        statusCode === 500
          ? "Internal Server Error"
          : error instanceof Error
            ? error.message
            : String(error)
    });
  });
  registerRetentionRoutes(app, {
    requireRetentionRepository: () => retentionRepository,
    requireHighRiskRepository: () =>
      ({ executeActionGrant, lookupLegalHoldTeamId }) as never,
    authenticateSessionContext: vi.fn(async () => ({
      sessionId: randomUUID(),
      createdAt: input?.sessionCreatedAt ?? new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: input?.sessionUser ?? user
    })),
    authenticateDeviceCredential: vi.fn(async () => auth),
    writeRateLimit: async () => undefined
  });
  await app.ready();
  return { app, auth, retentionRepository, executeActionGrant };
};

describe("Retention routes", () => {
  it.each([
    "/v1/retention/teams/not-a-uuid/policies/not-a-uuid/versions",
    "/v1/retention/teams/not-a-uuid/policies/not-a-uuid/shortening-previews",
    "/v1/retention/teams/not-a-uuid/policies/not-a-uuid/shortening-previews/not-a-uuid/confirmation",
    "/v1/retention/teams/not-a-uuid/deletion-request",
    "/v1/retention/owner-private-replicas/not-a-uuid/purge-request",
    "/v1/retention/users/me/erasure-request",
    "/v1/retention/legal-holds",
    "/v1/retention/legal-holds/not-a-uuid/release-request",
    "/v1/retention/legal-holds/not-a-uuid/release-confirmation"
  ])(
    "denies API Tokens before parsing malformed retention input at %s",
    async (url) => {
      const fixture = await createFixture();

      const response = await fixture.app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer personal-token" },
        payload: { malformed: true }
      });
      await fixture.app.close();

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "API Tokens cannot authorize retention operations"
      });
    }
  );

  it("denies API Tokens before accepting retention mutations", async () => {
    const requestRootTeamDeletion = vi.fn();
    const fixture = await createFixture({
      retentionRepository: { requestRootTeamDeletion } as never
    });

    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/deletion-request`,
      headers: { authorization: "Bearer personal-token" },
      payload: { expectedVersion: 1, retainUntil: "2099-01-01T00:00:00Z" }
    });
    await fixture.app.close();

    expect(response.statusCode).toBe(403);
    expect(requestRootTeamDeletion).not.toHaveBeenCalled();
  });

  it("does not accept caller-supplied retainUntil for root Team deletion", async () => {
    const requestRootTeamDeletion = vi.fn(async () => ({
      team: {
        id: teamId,
        name: "Retention Team",
        version: 2,
        lifecycle: "deletion_requested",
        deletionRequestedAt: new Date(),
        tombstonedAt: new Date(),
        retainUntil: new Date("2026-01-01T00:00:00.000Z"),
        purgeCompletedAt: null
      },
      decision: { id: randomUUID() },
      purgeJob: { id: randomUUID(), state: "pending" },
      requiredArtifacts: []
    }));
    const fixture = await createFixture({
      retentionRepository: { requestRootTeamDeletion } as never
    });

    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/deletion-request`,
      payload: { expectedVersion: 1, retainUntil: "2099-01-01T00:00:00Z" }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/deletion-request`,
      payload: { expectedVersion: 1 }
    });
    await fixture.app.close();

    expect(rejected.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(201);
    expect(requestRootTeamDeletion).toHaveBeenCalledWith(
      expect.not.objectContaining({ retainUntil: expect.anything() })
    );
  });

  it("requests source hard purge through a fresh high-risk boundary", async () => {
    const requestOwnerPrivateReplicaPurge = vi.fn(async () => ({
      ownerPrivateReplica: { id: ownerPrivateReplicaId },
      decision: { id: randomUUID(), trigger: "source_purge" },
      purgeJob: { id: randomUUID(), state: "pending" },
      requiredArtifacts: []
    }));
    const fixture = await createFixture({
      retentionRepository: { requestOwnerPrivateReplicaPurge } as never
    });
    const path = `/v1/retention/owner-private-replicas/${ownerPrivateReplicaId}/purge-request`;

    const denied = await fixture.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer personal-token" },
      payload: { expectedVersion: 1 }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: path,
      payload: { expectedVersion: 1, idempotencyKey: "source-purge-once" }
    });
    await fixture.app.close();

    expect(denied.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(201);
    expect(requestOwnerPrivateReplicaPurge).toHaveBeenCalledExactlyOnceWith({
      ownerPrivateReplicaId,
      actorUserId: user.id,
      expectedVersion: 1,
      trigger: "source_purge",
      idempotencyKey: "source-purge-once"
    });
  });

  it("tombstones User erasure only after every owner-private purge is queued", async () => {
    const calls: string[] = [];
    const listOwnerPrivateReplicasForUserErasure = vi.fn(async () => {
      calls.push("list");
      return [{ id: ownerPrivateReplicaId, logicalMemoryId, version: 4 }];
    });
    const requestOwnerPrivateReplicaPurge = vi.fn(async () => {
      calls.push("purge");
      return {
        ownerPrivateReplica: { id: ownerPrivateReplicaId },
        decision: { id: randomUUID(), trigger: "user_erasure" },
        purgeJob: { id: randomUUID(), state: "pending" },
        requiredArtifacts: []
      };
    });
    const completeUserErasureTombstone = vi.fn(async () => {
      calls.push("tombstone");
      return { userId: user.id, erasedAt: new Date() };
    });
    const fixture = await createFixture({
      retentionRepository: {
        listOwnerPrivateReplicasForUserErasure,
        requestOwnerPrivateReplicaPurge,
        completeUserErasureTombstone
      } as never
    });
    const path = "/v1/retention/users/me/erasure-request";

    const malformed = await fixture.app.inject({
      method: "POST",
      url: path,
      payload: { confirmation: "yes" }
    });
    const device = await fixture.app.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: { confirmation: "erase_my_user" }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: path,
      payload: { confirmation: "erase_my_user" }
    });
    await fixture.app.close();

    expect(malformed.statusCode).toBe(400);
    expect(device.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(202);
    expect(calls).toEqual(["list", "purge", "tombstone"]);
    expect(requestOwnerPrivateReplicaPurge).toHaveBeenCalledWith({
      ownerPrivateReplicaId,
      actorUserId: user.id,
      expectedVersion: 4,
      trigger: "user_erasure",
      idempotencyKey: `user-erasure:${user.id}:${ownerPrivateReplicaId}:v1`
    });
    expect(completeUserErasureTombstone).toHaveBeenCalledWith({
      userId: user.id
    });
  });

  it("requires a matching one-time device action grant for retention deletion", async () => {
    const actionGrant = "hrg_retention_once";
    const path = `/v1/retention/teams/${teamId}/deletion-request`;
    const body = { expectedVersion: 1 };
    const expectedScopeHash = retentionAdminScopeHash({
      action: "team.retention.delete_request",
      teamId,
      targetId: teamId
    });
    const expectedRequestHash = retentionAdminRequestHash({
      method: "POST",
      path,
      body
    });
    let consumed = false;
    const executeActionGrant = vi.fn(
      async (input: { [key: string]: unknown }) => {
        if (
          consumed ||
          input.actionGrant !== actionGrant ||
          input.scopeHash !== expectedScopeHash ||
          input.requestHash !== expectedRequestHash
        ) {
          return null;
        }
        consumed = true;
        return (
          input.execute as (args: {
            retention: RetentionLifecycleRepository;
          }) => Promise<unknown>
        )({
          retention: {
            requestRootTeamDeletion
          } as unknown as RetentionLifecycleRepository
        });
      }
    );
    const requestRootTeamDeletion = vi.fn(async () => ({
      team: {
        id: teamId,
        name: "Retention Team",
        version: 2,
        lifecycle: "deletion_requested",
        deletionRequestedAt: new Date(),
        tombstonedAt: new Date(),
        retainUntil: new Date(),
        purgeCompletedAt: null
      },
      decision: { id: randomUUID() },
      purgeJob: { id: randomUUID(), state: "pending" },
      requiredArtifacts: []
    }));
    const fixture = await createFixture({
      highRiskRepository: { executeActionGrant },
      retentionRepository: { requestRootTeamDeletion } as never
    });
    const headers = {
      authorization: "Koed-Device device-key:secret",
      "x-koed-action-grant": actionGrant
    };

    const altered = await fixture.app.inject({
      method: "POST",
      url: path,
      headers,
      payload: { expectedVersion: 2 }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: path,
      headers,
      payload: body
    });
    const replayed = await fixture.app.inject({
      method: "POST",
      url: path,
      headers,
      payload: body
    });
    await fixture.app.close();

    expect(altered.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(201);
    expect(replayed.statusCode).toBe(403);
    expect(requestRootTeamDeletion).toHaveBeenCalledTimes(1);
    expect(executeActionGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: user.id,
        deviceCredentialId: fixture.auth.credential.id,
        upstreamBackendId: fixture.auth.credential.upstreamBackendId,
        teamId,
        operationFamily: "admin",
        action: "team.retention.delete_request",
        targetId: teamId,
        scopeHash: expectedScopeHash,
        requestHash: expectedRequestHash
      })
    );
  });

  it("uses fresh browser-only mutations for policy version, exact shortening preview, and confirmation", async () => {
    const versionPolicy = vi.fn(async () => ({ id: randomUUID() }));
    const previewPolicyShortening = vi.fn(async () => ({
      id: previewId,
      previewHash: hash("policy preview"),
      affectedScopes: [{ targetKind: "team", targetId: teamId }]
    }));
    const confirmPolicyShortening = vi.fn(async () => ({
      id: randomUUID(),
      previewId,
      migratedDecisionIds: [randomUUID()]
    }));
    const fixture = await createFixture({
      retentionRepository: {
        versionPolicy,
        previewPolicyShortening,
        confirmPolicyShortening
      } as never
    });
    const effectiveAt = "2026-08-01T00:00:00.000Z";
    const versioned = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/policies/${policyId}/versions`,
      payload: {
        retentionSeconds: 86_400,
        deletionGraceSeconds: 3_600,
        backupRetentionSeconds: 604_800,
        effectiveAt
      }
    });
    const previewed = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/policies/${policyId}/shortening-previews`,
      payload: { policyVersion: 2, graceSeconds: 86_400 }
    });
    const confirmed = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/policies/${policyId}/shortening-previews/${previewId}/confirmation`,
      payload: {
        previewHash: hash("policy preview"),
        expectedAffectedScopeCount: 1
      }
    });
    const bearerRejected = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/policies/${policyId}/shortening-previews`,
      headers: { authorization: "Bearer personal-token" },
      payload: { policyVersion: 2, graceSeconds: 86_400 }
    });
    const deviceRejected = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/teams/${teamId}/policies/${policyId}/shortening-previews`,
      headers: { authorization: "Koed-Device device-key:secret" },
      payload: { policyVersion: 2, graceSeconds: 86_400 }
    });
    await fixture.app.close();

    expect(versioned.statusCode).toBe(201);
    expect(previewed.statusCode).toBe(201);
    expect(confirmed.statusCode).toBe(200);
    expect(bearerRejected.statusCode).toBe(403);
    expect(deviceRejected.statusCode).toBe(403);
    expect(versionPolicy).toHaveBeenCalledWith({
      policyId,
      retentionSeconds: 86_400,
      deletionGraceSeconds: 3_600,
      backupRetentionSeconds: 604_800,
      effectiveAt: new Date(effectiveAt),
      actorUserId: user.id,
      expectedTeamId: teamId
    });
    expect(previewPolicyShortening).toHaveBeenCalledWith({
      policyId,
      policyVersion: 2,
      actorUserId: user.id,
      expectedTeamId: teamId,
      graceSeconds: 86_400
    });
    expect(confirmPolicyShortening).toHaveBeenCalledWith({
      previewId,
      previewHash: hash("policy preview"),
      expectedAffectedScopeCount: 1,
      actorUserId: user.id,
      expectedTeamId: teamId,
      expectedPolicyId: policyId
    });
  });

  it("routes legal hold release request and confirmation as separate mutations", async () => {
    const requestLegalHoldRelease = vi.fn(async () =>
      hold({
        state: "release_pending",
        releaseRequestedByUserId: user.id,
        releaseRequestedAt: new Date()
      })
    );
    const confirmLegalHoldRelease = vi.fn(async () =>
      hold({
        state: "released",
        releaseRequestedByUserId: user.id,
        releaseRequestedAt: new Date(),
        releaseConfirmedByUserId: secondUser.id,
        releaseConfirmedAt: new Date(),
        releasedAt: new Date()
      })
    );
    const fixture = await createFixture({
      retentionRepository: {
        requestLegalHoldRelease,
        confirmLegalHoldRelease
      } as never
    });

    const requested = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/legal-holds/${holdId}/release-request`,
      payload: {}
    });
    const confirmed = await fixture.app.inject({
      method: "POST",
      url: `/v1/retention/legal-holds/${holdId}/release-confirmation`,
      payload: {}
    });
    await fixture.app.close();

    expect(requested.statusCode).toBe(200);
    expect(confirmed.statusCode).toBe(200);
    expect(requestLegalHoldRelease).toHaveBeenCalledWith({
      holdId,
      actorUserId: user.id
    });
    expect(confirmLegalHoldRelease).toHaveBeenCalledWith({
      holdId,
      actorUserId: user.id,
      singleHolderReleaseException: undefined
    });
  });
});
