import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationRendererCommandSchema,
  readCollaborationActionGrantCustodyStatus,
  type CollaborationRendererCommand
} from "@koed/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCollaborationActionGrantControl,
  type CollaborationActionGrantControlContext
} from "./collaboration-action-grant-control.js";
import type { LocalEdgeUpstreamBackend } from "./upstream-routing.js";

const temps: string[] = [];

const tempHome = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), "koed-collab-action-grant-"));
  temps.push(root);
  return root;
};

afterEach(() => {
  for (const path of temps.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const ids = {
  request: "00000000-0000-4000-8000-000000000001",
  commandRequest: "00000000-0000-4000-8000-000000000002",
  team: "00000000-0000-4000-8000-000000000003",
  workspace: "00000000-0000-4000-8000-000000000004",
  principal: "00000000-0000-4000-8000-000000000005",
  device: "00000000-0000-4000-8000-000000000006",
  actionGrant: "00000000-0000-4000-8000-000000000007",
  selector: "00000000-0000-4000-8000-000000000013",
  logicalMemory: "00000000-0000-4000-8000-000000000008",
  remoteReplica: "00000000-0000-4000-8000-000000000009",
  consent: "00000000-0000-4000-8000-000000000010",
  mutation: "00000000-0000-4000-8000-000000000011",
  logicalGrant: "00000000-0000-4000-8000-000000000012"
} as const;

const approvalReview = {
  version: 1 as const,
  title: "Create Workspace?",
  description: "Review the exact Workspace creation request.",
  consequence: "A new shared Workspace will be created.",
  confirmLabel: "Create Workspace",
  details: [{ label: "Team", value: "Koed Team" }]
};

const backend = (
  overrides: Partial<LocalEdgeUpstreamBackend> = {}
): LocalEdgeUpstreamBackend => ({
  id: "team-vps",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {
    teamWorkspaceRead: "enabled",
    admin: "enabled",
    shareGrantManagement: "enabled"
  },
  ...overrides
});

const parsedCommand = <T extends CollaborationRendererCommand>(
  value: Omit<T, "contractVersion" | "requestId"> & { requestId?: string }
): T =>
  collaborationRendererCommandSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: value.requestId ?? ids.request,
    ...value
  }) as T;

type RequestActionGrantCommand = Extract<
  CollaborationRendererCommand,
  { command: "collaboration.request_action_grant" }
>;
type CreateWorkspaceGrantCommand = RequestActionGrantCommand & {
  input: {
    intent: Extract<
      RequestActionGrantCommand["input"]["intent"],
      { intent: "collaboration.create_workspace" }
    >;
  };
};

const pendingStatus = (expiresAt: string) => ({
  status: {
    version: 1,
    actionGrant: { id: ids.actionGrant },
    selector: ids.selector,
    approvalTier: "step_up",
    review: approvalReview,
    state: "pending",
    activationPath: `/v1/high-risk/browser-activations/${ids.selector}`,
    expiresAt
  }
});

const approvedStatus = (expiresAt: string) => ({
  status: {
    version: 1,
    actionGrant: { id: ids.actionGrant },
    selector: ids.selector,
    approvalTier: "step_up",
    review: approvalReview,
    state: "approved",
    activationPath: null,
    expiresAt
  }
});

const nativeStatus = (
  expiresAt: string,
  state: "review_required" | "approved"
) => ({
  status: {
    version: 1,
    actionGrant: { id: ids.actionGrant },
    selector: ids.selector,
    approvalTier: "native_review",
    review: approvalReview,
    state,
    activationPath: null,
    expiresAt
  }
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

describe("collaboration Action Grant control", () => {
  const startIso = "2026-07-17T03:00:00.000Z";
  const expiresAt = "2026-07-17T03:05:00.000Z";
  const approvedExpiresAt = "2026-07-17T03:01:00.000Z";

  const createFixture = (
    input: {
      fetch?: ReturnType<typeof vi.fn>;
      nowRef?: { value: Date };
      context?: Partial<CollaborationActionGrantControlContext>;
      backend?: LocalEdgeUpstreamBackend;
    } = {}
  ) => {
    const koedHome = tempHome();
    const nowRef = input.nowRef ?? { value: new Date(startIso) };
    const fetchMock =
      input.fetch ?? vi.fn(async () => jsonResponse(pendingStatus(expiresAt)));
    const control = createCollaborationActionGrantControl({
      koedHome,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => nowRef.value,
      randomUuid: () => ids.actionGrant,
      randomBytes: (size) => Buffer.alloc(size, 0x41),
      random: () => 0.25
    });
    const context: CollaborationActionGrantControlContext = {
      backend: input.backend ?? backend(),
      principalUserId: ids.principal,
      upstreamDeviceCredentialId: ids.device,
      upstreamDeviceAuthorization: "Koed-Device device-key:device-secret",
      operationFamilies: new Set(["action_grant"]),
      ...input.context
    };
    return { koedHome, nowRef, fetchMock, control, context };
  };

  const requestCommand = (): CreateWorkspaceGrantCommand => {
    const command = parsedCommand<RequestActionGrantCommand>({
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.create_workspace",
          commandRequestId: ids.commandRequest,
          teamId: ids.team,
          name: "Research",
          description: "Shared research"
        }
      }
    });
    if (command.input.intent.intent !== "collaboration.create_workspace") {
      throw new Error("Expected create-workspace Action Grant intent");
    }
    return command as CreateWorkspaceGrantCommand;
  };

  const previewGrantCommand = () =>
    parsedCommand<
      Extract<
        CollaborationRendererCommand,
        { command: "collaboration.request_action_grant" }
      >
    >({
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.preview_shared_memory",
          commandRequestId: ids.commandRequest,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          representation: "memory_events",
          allowedRepresentations: ["memory_events", "lcm_leaves"]
        }
      }
    });

  const shareGrantCommand = () =>
    parsedCommand<
      Extract<
        CollaborationRendererCommand,
        { command: "collaboration.request_action_grant" }
      >
    >({
      command: "collaboration.request_action_grant",
      input: {
        intent: {
          intent: "collaboration.share_memory",
          commandRequestId: ids.commandRequest,
          mutationId: ids.mutation,
          logicalGrantId: ids.logicalGrant,
          consentId: ids.consent,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          mode: "continuous",
          allowedRepresentations: ["memory_events", "lcm_leaves"],
          selectedRepresentation: "memory_events",
          previewRevision: 2,
          previewHash: "b".repeat(64),
          expiresAt: null
        }
      }
    });

  const pollCommand = () =>
    parsedCommand({
      command: "collaboration.await_action_grant",
      input: { actionGrant: { id: ids.actionGrant } }
    });

  const cancelCommand = () =>
    parsedCommand({
      command: "collaboration.cancel_action_grant",
      input: { actionGrant: { id: ids.actionGrant } }
    });

  const confirmCommand = () =>
    parsedCommand({
      command: "collaboration.confirm_action_grant",
      input: {
        actionGrant: { id: ids.actionGrant },
        decision: "approve"
      }
    });

  it("creates a pending Action Grant without exposing secrets or credentials to the renderer", async () => {
    const fixture = createFixture();

    const result = await fixture.control.dispatch(
      requestCommand(),
      fixture.context
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.request_action_grant",
      data: {
        status: {
          actionGrant: { id: ids.actionGrant },
          state: "pending",
          activationUrl: `https://team.example.test/koed/v1/high-risk/browser-activations/${ids.selector}`,
          expiresAt
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain("device-secret");
    expect(JSON.stringify(result)).not.toContain("commitmentHash");

    const [url, init] = fixture.fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://team.example.test/koed/v1/high-risk/action-grants"
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      "Koed-Device device-key:device-secret"
    );
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-koed-action-grant")).toBeNull();
    expect(String(init?.body)).not.toContain("hrg_");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      intent: {
        action: "team.workspace.create",
        teamId: ids.team,
        body: { name: "Research", description: "Shared research" }
      }
    });
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => fixture.nowRef.value }
      )
    ).toMatchObject({
      state: "pending",
      activationUrl: `https://team.example.test/koed/v1/high-risk/browser-activations/${ids.selector}`
    });
  });

  it("binds preview Action Grants to the exact shared-memory remote request for share_grant_management devices", async () => {
    const fixture = createFixture({
      context: {
        operationFamilies: new Set(["share_grant_management"]),
        resolveSharedMemoryPreviewTarget: async () => ({
          remoteReplicaId: ids.remoteReplica
        })
      }
    });

    const result = await fixture.control.dispatch(
      previewGrantCommand(),
      fixture.context
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.request_action_grant",
      data: {
        status: {
          actionGrant: { id: ids.actionGrant },
          state: "pending"
        }
      }
    });

    const [, init] = fixture.fetchMock.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as {
      version: number;
      clientRequestId: string;
      grantCommitment: string;
      intent: Record<string, unknown>;
    };
    expect(payload.version).toBe(1);
    expect(payload.clientRequestId).toBe(ids.actionGrant);
    expect(payload.grantCommitment).toMatch(/^v1:[0-9a-f]{64}$/i);
    expect(payload.intent).toEqual({
      action: "shared_memory.preview",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.remoteReplica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      representation: "memory_events",
      allowedRepresentations: ["memory_events", "lcm_leaves"]
    });
  });

  it("resolves the persisted preview before binding a one-review share bundle", async () => {
    const fixture = createFixture({
      context: {
        operationFamilies: new Set(["share_grant_management"]),
        resolveSharedMemoryConsentPreview: async () => ({
          previewId: ids.remoteReplica
        })
      }
    });

    const result = await fixture.control.dispatch(
      shareGrantCommand(),
      fixture.context
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.request_action_grant"
    });
    const [, init] = fixture.fetchMock.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as {
      intent: Record<string, unknown>;
    };
    expect(payload.intent).toEqual({
      action: "shared_memory.share",
      mutationId: ids.mutation,
      logicalGrantId: ids.logicalGrant,
      consentId: ids.consent,
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      previewId: ids.remoteReplica,
      mode: "continuous",
      allowedRepresentations: ["memory_events", "lcm_leaves"],
      selectedRepresentation: "memory_events",
      previewRevision: 2,
      previewHash: "b".repeat(64),
      expiresAt: null
    });
  });

  it("maps shared-memory Action Grant intents to the exact existing protected routes", () => {
    const fixture = createFixture();

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.share_memory",
        commandRequestId: ids.commandRequest,
        mutationId: ids.mutation,
        logicalGrantId: ids.logicalGrant,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        consentId: ids.consent,
        mode: "continuous",
        allowedRepresentations: ["memory_events", "lcm_leaves"],
        selectedRepresentation: "memory_events",
        previewRevision: 2,
        previewHash: "b".repeat(64),
        expiresAt: null
      })
    ).toBeNull();

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.revoke_shared_memory",
        commandRequestId: ids.commandRequest,
        mutationId: ids.mutation,
        teamId: ids.team,
        workspaceId: ids.workspace,
        shareGrantId: ids.logicalGrant,
        expectedGrantVersion: 3,
        reasonCode: "owner_revoked"
      })
    ).toEqual({
      operationFamily: "share_grant_management",
      action: `shared_memory.revoke.${ids.workspace}`,
      teamId: ids.team,
      targetId: ids.logicalGrant,
      method: "POST",
      path: `/v1/shared-memory/share-grants/${ids.logicalGrant}/revoke`,
      body: {
        mutationId: ids.mutation,
        teamId: ids.team,
        teamWorkspaceId: ids.workspace,
        expectedGrantVersion: 3,
        reasonCode: "owner_revoked",
        authority: {
          action: "workspace.memory.share_owned",
          source: "device_action_grant",
          referenceId: ids.commandRequest
        }
      },
      idempotencyKey: ids.commandRequest
    });

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.change_shared_memory_representation",
        commandRequestId: ids.commandRequest,
        mutationId: ids.mutation,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        shareGrantId: ids.logicalGrant,
        consentId: ids.consent,
        representation: "lcm_leaves",
        expectedGrantVersion: 4,
        mode: "continuous",
        allowedRepresentations: ["lcm_leaves"],
        previewRevision: 2,
        previewHash: "b".repeat(64),
        expiresAt: null
      })
    ).toBeNull();
  });

  it("maps Team Action Grant intents to the exact protected Team-control routes", () => {
    const fixture = createFixture();

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.join_team",
        commandRequestId: ids.commandRequest,
        invitation:
          "https://team.example.test/koed/invitations/accept?token=kti_validInvitationToken123456"
      })
    ).toEqual({
      operationFamily: "admin",
      action: "team.invite.accept",
      teamId: null,
      targetId: null,
      method: "POST",
      path: "/v1/team-invites/accept",
      body: { inviteToken: "kti_validInvitationToken123456" },
      idempotencyKey: ids.commandRequest
    });

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.leave_team",
        commandRequestId: ids.commandRequest,
        teamId: ids.team,
        expectedVersion: 2
      })
    ).toEqual({
      operationFamily: "admin",
      action: "team.leave",
      teamId: ids.team,
      targetId: ids.team,
      method: "POST",
      path: `/v1/teams/${ids.team}/leave`,
      body: { expectedVersion: 2 },
      idempotencyKey: ids.commandRequest
    });

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.revoke_invitation",
        commandRequestId: ids.commandRequest,
        teamId: ids.team,
        invitationId: ids.logicalGrant,
        expectedVersion: 3
      })
    ).toEqual({
      operationFamily: "admin",
      action: "team.invite.revoke",
      teamId: ids.team,
      targetId: ids.logicalGrant,
      method: "DELETE",
      path: `/v1/teams/${ids.team}/invites/${ids.logicalGrant}`,
      body: { expectedVersion: 3 },
      idempotencyKey: ids.commandRequest
    });

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.archive_workspace",
        commandRequestId: ids.commandRequest,
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 4
      })
    ).toEqual({
      operationFamily: "admin",
      action: "team.workspace.archive",
      teamId: ids.team,
      targetId: ids.workspace,
      method: "POST",
      path: `/v1/team-workspaces/${ids.workspace}/archive`,
      body: { expectedVersion: 4 },
      idempotencyKey: ids.commandRequest
    });

    expect(
      fixture.control.describeIntent(fixture.context.backend, {
        intent: "collaboration.restore_workspace",
        commandRequestId: ids.commandRequest,
        teamId: ids.team,
        workspaceId: ids.workspace,
        expectedVersion: 5
      })
    ).toEqual({
      operationFamily: "admin",
      action: "team.workspace.restore",
      teamId: ids.team,
      targetId: ids.workspace,
      method: "POST",
      path: `/v1/team-workspaces/${ids.workspace}/restore`,
      body: { expectedVersion: 5 },
      idempotencyKey: ids.commandRequest
    });
  });

  it("rejects Team invitation origins outside the enrolled backend", async () => {
    const fixture = createFixture();

    const result = await fixture.control.dispatch(
      parsedCommand({
        command: "collaboration.request_action_grant",
        input: {
          intent: {
            intent: "collaboration.join_team",
            commandRequestId: ids.commandRequest,
            invitation:
              "https://evil.example.test/koed/invitations/accept?token=kti_validInvitationToken123456"
          }
        }
      }),
      fixture.context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" }
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects share-grant-management requests from admin-only devices", async () => {
    const fixture = createFixture();

    const result = await fixture.control.dispatch(
      previewGrantCommand(),
      fixture.context
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission_denied" }
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the secret only after authoritative approved polling", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingStatus(expiresAt)))
      .mockResolvedValueOnce(jsonResponse(approvedStatus(approvedExpiresAt)));
    const fixture = createFixture({ fetch: fetchMock });

    await fixture.control.dispatch(requestCommand(), fixture.context);
    const polled = await fixture.control.dispatch(
      pollCommand(),
      fixture.context
    );

    expect(polled).toMatchObject({
      ok: true,
      command: "collaboration.await_action_grant",
      data: {
        status: {
          actionGrant: { id: ids.actionGrant },
          state: "approved",
          activationUrl: null,
          expiresAt: approvedExpiresAt
        }
      }
    });
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => fixture.nowRef.value }
      )
    ).toMatchObject({
      state: "approved",
      expiresAt: approvedExpiresAt
    });

    const secret = await fixture.control.resolveSecret({
      reference: { id: ids.actionGrant },
      intent: requestCommand().input.intent,
      context: fixture.context
    });
    expect(secret).toMatch(/^hrg_[A-Za-z0-9_-]{43}$/);
  });

  it("reconciles a Native-review approval after a retryable decision response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(nativeStatus(expiresAt, "review_required"))
      )
      .mockResolvedValueOnce(jsonResponse({ error: "gateway timeout" }, 502))
      .mockResolvedValueOnce(
        jsonResponse(nativeStatus(approvedExpiresAt, "approved"))
      );
    const fixture = createFixture({ fetch: fetchMock });

    await fixture.control.dispatch(requestCommand(), fixture.context);
    const confirmation = await fixture.control.dispatch(
      confirmCommand(),
      fixture.context
    );
    expect(confirmation).toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable", retryable: true }
    });

    const reconciled = await fixture.control.dispatch(
      pollCommand(),
      fixture.context
    );
    expect(reconciled).toMatchObject({
      ok: true,
      data: {
        status: {
          approvalTier: "native_review",
          state: "approved"
        }
      }
    });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      `/v1/high-risk/action-grants/${ids.actionGrant}/await`
    );
  });

  it("deletes local custody when secret resolution input is tampered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingStatus(expiresAt)))
      .mockResolvedValueOnce(jsonResponse(approvedStatus(approvedExpiresAt)));
    const fixture = createFixture({ fetch: fetchMock });

    await fixture.control.dispatch(requestCommand(), fixture.context);
    await fixture.control.dispatch(pollCommand(), fixture.context);

    expect(
      await fixture.control.resolveSecret({
        reference: { id: ids.actionGrant },
        intent: {
          ...requestCommand().input.intent,
          description: "Tampered payload"
        },
        context: fixture.context
      })
    ).toBeNull();
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => fixture.nowRef.value }
      )
    ).toBeNull();
  });

  it("fails closed when the remote activation path is malformed or leaks a secret-shaped token", async () => {
    for (const activationPath of [
      `/v1/high-risk/browser-activations/${ids.selector}?bad=1`,
      `/v1/high-risk/browser-activations/hrg_${"A".repeat(43)}`
    ]) {
      const fixture = createFixture({
        fetch: vi.fn(async () =>
          jsonResponse({
            status: {
              version: 1,
              actionGrant: { id: ids.actionGrant },
              selector: ids.selector,
              approvalTier: "step_up",
              review: approvalReview,
              state: "pending",
              activationPath,
              expiresAt
            }
          })
        )
      });

      const result = await fixture.control.dispatch(
        requestCommand(),
        fixture.context
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "temporarily_unavailable" }
      });
      expect(JSON.stringify(result)).not.toContain("hrg_");
    }
  });

  it("cancels a pending Action Grant and removes local custody", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingStatus(expiresAt)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const fixture = createFixture({ fetch: fetchMock });

    await fixture.control.dispatch(requestCommand(), fixture.context);
    const canceled = await fixture.control.dispatch(
      cancelCommand(),
      fixture.context
    );

    expect(canceled).toMatchObject({
      ok: true,
      command: "collaboration.cancel_action_grant",
      data: {
        status: {
          actionGrant: { id: ids.actionGrant },
          state: "canceled",
          activationUrl: null,
          expiresAt
        }
      }
    });
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => fixture.nowRef.value }
      )
    ).toBeNull();
  });

  it.each(["consumed", "denied", "revoked", "expired", "canceled"] as const)(
    "applies authoritative %s polling cleanup through the shared lifecycle",
    async (state) => {
      const terminal = approvedStatus(approvedExpiresAt);
      terminal.status.state = state;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(pendingStatus(expiresAt)))
        .mockResolvedValueOnce(jsonResponse(terminal));
      const fixture = createFixture({ fetch: fetchMock });

      await fixture.control.dispatch(requestCommand(), fixture.context);
      const polled = await fixture.control.dispatch(
        pollCommand(),
        fixture.context
      );

      expect(polled).toMatchObject({
        ok: true,
        data: { status: { state } }
      });
      expect(
        readCollaborationActionGrantCustodyStatus(
          fixture.koedHome,
          {
            referenceId: ids.actionGrant,
            backendId: "team-vps",
            deploymentBaseUrl: "https://team.example.test/koed",
            deviceCredentialId: ids.device,
            principalUserId: ids.principal
          },
          { now: () => fixture.nowRef.value }
        )
      ).toBeNull();
    }
  );

  it("retains only a bounded ambiguous-response window on malformed polling", async () => {
    const nowRef = { value: new Date(startIso) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pendingStatus(expiresAt)))
      .mockResolvedValueOnce(jsonResponse({ status: { id: ids.actionGrant } }));
    const fixture = createFixture({ fetch: fetchMock, nowRef });

    await fixture.control.dispatch(requestCommand(), fixture.context);
    const malformed = await fixture.control.dispatch(
      pollCommand(),
      fixture.context
    );

    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "temporarily_unavailable" }
    });
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => nowRef.value }
      )
    ).toMatchObject({
      state: "pending",
      activationUrl: `https://team.example.test/koed/v1/high-risk/browser-activations/${ids.selector}`
    });
    expect(
      await fixture.control.resolveSecret({
        reference: { id: ids.actionGrant },
        intent: requestCommand().input.intent,
        context: fixture.context
      })
    ).toBeNull();

    nowRef.value = new Date("2026-07-17T03:00:31.000Z");
    expect(
      readCollaborationActionGrantCustodyStatus(
        fixture.koedHome,
        {
          referenceId: ids.actionGrant,
          backendId: "team-vps",
          deploymentBaseUrl: "https://team.example.test/koed",
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => nowRef.value }
      )
    ).toBeNull();
  });
});
