import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectSharePolicyClient } from "./project-share-policy-client.js";
import { projectPolicyRendererProjection } from "./workspace-project-service.js";

const ids = {
  personal: randomUUID(),
  owner: randomUUID(),
  backend: "team-primary",
  workspaceProject: randomUUID(),
  workspace: randomUUID(),
  team: randomUUID(),
  principal: randomUUID(),
  session: randomUUID(),
  logicalMemory: randomUUID(),
  manifest: randomUUID(),
  policy: randomUUID(),
  device: randomUUID(),
  grant: randomUUID()
};
const signingKey = Buffer.alloc(44, 1).toString("base64");
const entry = {
  sessionId: ids.session,
  logicalMemoryId: ids.logicalMemory,
  sourceRevision: 2,
  mappingRevision: 3,
  reviewLabel: "Calculus review"
};
const initialManifestHash = createHash("sha256")
  .update(
    JSON.stringify({
      entries: [entry],
      signingPublicKey: signingKey
    })
  )
  .digest("hex");
const link = {
  ownerUserId: ids.owner,
  teamBackendId: ids.backend,
  workspaceProjectId: ids.workspaceProject
};
const context = {
  state: "ready" as const,
  backendId: ids.backend,
  profile: "koed_managed_cloud" as const,
  principalId: ids.principal,
  teams: [
    {
      id: ids.team,
      name: "Study team",
      role: "member" as const,
      people: [],
      workspaces: [
        { id: ids.workspace, name: "Exam", access: "write" as const }
      ]
    }
  ]
};
const policy = (status: "absent" | "active" | "revoked", version: number) => ({
  policyId: status === "absent" ? null : ids.policy,
  ownerTeamMemberId: ids.principal,
  projectId: ids.workspaceProject,
  teamId: ids.team,
  workspaceId: ids.workspace,
  projectName: "Exam",
  policyVersion: version,
  status,
  manifestId: null,
  manifestHash: null,
  signingPublicKey: status === "absent" ? null : signingKey,
  deviceCredentialId: status === "absent" ? null : ids.device,
  personalProjectBindingHash: status === "absent" ? null : "a".repeat(64),
  eligibleCount: 1,
  reviewSources: [
    { sessionId: ids.session, reviewLabel: entry.reviewLabel, eligible: true }
  ]
});
const fixture = () => {
  let currentPolicy = policy("absent", 0);
  let currentEntries = [entry];
  let signingPublicKey = signingKey;
  let receiptOverride: Record<string, unknown> = {};
  let reviewOverride: Record<string, unknown> = {};
  const loadContext = vi.fn(async () => context);
  const loadLink = vi.fn(async () => link);
  const loadManifest = vi.fn(async () => ({
    personalProjectBindingHash: "a".repeat(64),
    deviceCredentialId: ids.device,
    signingPublicKey,
    entries: currentEntries
  }));
  const loadLocalState = vi.fn(async () => ({
    policyVersion:
      currentPolicy.status === "active" ? currentPolicy.policyVersion : null,
    deviceCredentialId: currentPolicy.status === "active" ? ids.device : null,
    currentDeviceCredentialId: ids.device,
    signingPublicKey: currentPolicy.status === "active" ? signingKey : null,
    currentBindingHash: "a".repeat(64)
  }));
  const sendPolicy = vi.fn(async (_backend: string, path: string) => {
    if (path.endsWith("/status")) return currentPolicy;
    if (path.endsWith("/manifests"))
      return {
        manifestId: ids.manifest,
        manifestHash: initialManifestHash,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        projectId: ids.workspaceProject,
        ownerTeamMemberId: ids.principal,
        deviceCredentialId: ids.device,
        upstreamBackendId: ids.backend,
        expectedPolicyVersion: currentPolicy.policyVersion,
        personalProjectBindingHash: "a".repeat(64),
        signingPublicKey: signingKey,
        entries: [entry],
        ...receiptOverride
      };
    if (path.includes(`/manifests/${ids.manifest}/review?`))
      return {
        ...currentPolicy,
        manifestId: ids.manifest,
        manifestHash: initialManifestHash,
        signingPublicKey: signingKey,
        ...reviewOverride
      };
    throw new Error("Unexpected Team policy path");
  });
  const consumeLocal = vi.fn(
    async (
      _personal: string,
      _backend: string,
      _teamProject: string,
      _grant: string,
      _intent: unknown,
      payload: unknown
    ) => {
      if ((payload as { manifestId?: string }).manifestId) {
        currentPolicy = policy("active", 1);
        return { policyId: ids.policy, version: 1, eligible: [entry] };
      }
      currentPolicy = policy("revoked", 2);
      return { policyId: ids.policy, version: 2 };
    }
  );
  type Pending = {
    attemptId: string;
    action: "enable" | "revoke";
    clientRequestId: string;
    actionGrantId: string;
    teamBackendId: string;
    workspaceProjectId: string;
    teamId: string;
    teamPrincipalUserId: string;
    deviceCredentialId: string;
    expectedPolicyVersion: number;
    manifestId?: string;
    manifestHash?: string;
    payloadHash: string;
  };
  let pending: Pending[] = [];
  const startAttempt = vi.fn(
    async (
      _personal: string,
      _backend: string,
      _project: string,
      grantId: string,
      intent: {
        intent: string;
        commandRequestId: string;
        expectedPolicyVersion: number;
        manifestId?: string;
        manifestHash?: string;
      }
    ) => {
      const attemptId = randomUUID();
      pending.push({
        attemptId,
        action: intent.intent.endsWith("enable") ? "enable" : "revoke",
        clientRequestId: intent.commandRequestId,
        actionGrantId: grantId,
        teamBackendId: ids.backend,
        workspaceProjectId: ids.workspaceProject,
        teamId: ids.team,
        teamPrincipalUserId: ids.principal,
        deviceCredentialId: ids.device,
        expectedPolicyVersion: intent.expectedPolicyVersion,
        ...(intent.manifestId
          ? { manifestId: intent.manifestId, manifestHash: intent.manifestHash }
          : {}),
        payloadHash: "a".repeat(64)
      });
      return { attemptId, state: "pending" as const };
    }
  );
  const pendingAttempts = vi.fn(async () => ({ attempts: pending }));
  const finalizeAttempt = vi.fn(
    async (
      _personal: string,
      _backend: string,
      attemptId: string
    ): Promise<
      | { state: "unknown" }
      | { state: "terminal"; reason: "denied" | "revoked" | "expired" }
      | { state: "finalized"; action: "enable" | "revoke"; version: number }
    > => {
      const found = pending.find((item) => item.attemptId === attemptId);
      if (!found) return { state: "unknown" as const };
      pending = pending.filter((item) => item.attemptId !== attemptId);
      return {
        state: "finalized" as const,
        action: found.action,
        version: found.expectedPolicyVersion + 1
      };
    }
  );
  const stageLocal = vi.fn(async () => ({
    state: "staged" as const,
    pendingShareId: randomUUID()
  }));
  const client = createProjectSharePolicyClient({
    loadContext,
    loadLink,
    loadManifest,
    loadLocalState,
    sendPolicy,
    consumeLocal,
    startAttempt,
    pendingAttempts,
    finalizeAttempt,
    stageLocal
  });
  return {
    client,
    sendPolicy,
    consumeLocal,
    startAttempt,
    pendingAttempts,
    finalizeAttempt,
    setPending: (value: Pending[]) => {
      pending = value;
    },
    stageLocal,
    loadManifest,
    loadLocalState,
    setContext: (value: typeof context) => loadContext.mockResolvedValue(value),
    setEntries: (value: typeof currentEntries) => {
      currentEntries = value;
    },
    setSigningPublicKey: (value: string) => {
      signingPublicKey = value;
    },
    setReceipt: (value: Record<string, unknown>) => {
      receiptOverride = value;
    },
    setReview: (value: Record<string, unknown>) => {
      reviewOverride = value;
    },
    setPolicy: (value: typeof currentPolicy) => {
      currentPolicy = value;
    }
  };
};

describe("Project summary policy desktop boundary", () => {
  it("projects only review copy to the renderer, never source or authority IDs", () => {
    const publicStatus = projectPolicyRendererProjection(policy("active", 1));
    expect(publicStatus).toEqual({
      status: "active",
      pendingAction: null,
      reviewRequired: false,
      eligibleCount: 1,
      reviewSources: [{ reviewLabel: entry.reviewLabel, eligible: true }]
    });
    expect(JSON.stringify(publicStatus)).not.toContain(ids.session);
    expect(JSON.stringify(publicStatus)).not.toContain(ids.policy);
    expect(JSON.stringify(publicStatus)).not.toContain(ids.workspaceProject);
  });

  it("requires fresh review after a same-link epoch or device changes without adopting Team active state", async () => {
    for (const changed of [
      { currentBindingHash: "b".repeat(64) },
      { deviceCredentialId: randomUUID() },
      { currentDeviceCredentialId: randomUUID() },
      { signingPublicKey: Buffer.alloc(44, 2).toString("base64") },
      { policyVersion: null }
    ]) {
      const item = fixture();
      item.setPolicy(policy("active", 1));
      item.loadLocalState.mockResolvedValue({
        policyVersion: 1,
        deviceCredentialId: ids.device,
        currentDeviceCredentialId: ids.device,
        signingPublicKey: signingKey,
        currentBindingHash: "a".repeat(64),
        ...changed
      });
      const status = await item.client.status(ids.personal);
      expect(status.reviewRequired).toBe(true);
      expect(
        projectPolicyRendererProjection(
          status.policy,
          status.pendingAction,
          status.reviewRequired
        )
      ).toMatchObject({ status: "active", reviewRequired: true });
      await expect(item.client.currentForIssue(ids.personal)).rejects.toThrow(
        "fresh Native review"
      );
      await expect(item.client.stageInitial(ids.personal)).rejects.toThrow(
        "not active"
      );
      await expect(
        item.client.prepareRevoke(ids.personal)
      ).resolves.toMatchObject({
        policy: { status: "active", policyVersion: 1 }
      });
      expect(item.stageLocal).not.toHaveBeenCalled();
    }
  });

  it("rejects a Team/Workspace mismatch before staging a manifest", async () => {
    const item = fixture();
    item.setContext({ ...context, teams: [] });
    await expect(item.client.prepareEnable(ids.personal)).rejects.toThrow(
      "authority"
    );
    expect(item.loadManifest).not.toHaveBeenCalled();
  });

  it("rejects foreign Team manifest echo before any Native Action Grant", async () => {
    for (const changed of [
      { projectId: randomUUID() },
      { ownerTeamMemberId: randomUUID() },
      { deviceCredentialId: randomUUID() },
      { upstreamBackendId: "foreign-backend" },
      { signingPublicKey: Buffer.alloc(44, 2).toString("base64") },
      { entries: [{ ...entry, sourceRevision: 3 }] }
    ]) {
      const item = fixture();
      item.setReceipt(changed);
      await expect(item.client.prepareEnable(ids.personal)).rejects.toThrow(
        "differs from trusted Personal sources"
      );
      expect(item.consumeLocal).not.toHaveBeenCalled();
    }
  });

  it("rejects a prepared Team review with a different source set or key", async () => {
    for (const changed of [
      { signingPublicKey: Buffer.alloc(44, 2).toString("base64") },
      {
        reviewSources: [
          {
            sessionId: randomUUID(),
            reviewLabel: entry.reviewLabel,
            eligible: true
          }
        ]
      }
    ]) {
      const item = fixture();
      item.setReview(changed);
      await expect(item.client.prepareEnable(ids.personal)).rejects.toThrow(
        "Native review differs"
      );
    }
  });

  it("rechecks the owner-local manifest before exact grant consumption", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    item.setEntries([{ ...entry, sourceRevision: 3 }]);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    await expect(
      item.client.enable(ids.personal, prepared, intent, ids.grant)
    ).rejects.toThrow("expired or changed");
    expect(item.consumeLocal).not.toHaveBeenCalled();
  });

  it("rejects a changed sealed proof key before grant consumption", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    item.setSigningPublicKey(Buffer.alloc(44, 2).toString("base64"));
    await expect(
      item.client.enable(
        ids.personal,
        prepared,
        {
          intent: "collaboration.project_share_policy_enable",
          commandRequestId: randomUUID(),
          teamId: ids.team,
          projectId: ids.workspaceProject,
          expectedPolicyVersion: 0,
          manifestId: ids.manifest,
          manifestHash: initialManifestHash
        },
        ids.grant
      )
    ).rejects.toThrow("expired or changed");
    expect(item.consumeLocal).not.toHaveBeenCalled();
  });

  it("consumes the exact owner-local grant and activates only after Team receipt", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    const result = await item.client.enable(
      ids.personal,
      prepared,
      intent,
      ids.grant
    );
    expect(result.policy.status).toBe("active");
    expect(result.initialStage).toMatchObject({
      stagedCount: 1,
      pendingCount: 1,
      needsReviewCount: 0
    });
    expect(item.stageLocal).toHaveBeenCalledWith(
      ids.personal,
      ids.backend,
      ids.workspaceProject,
      ids.session,
      1
    );
    expect(item.consumeLocal).toHaveBeenCalledWith(
      ids.personal,
      ids.backend,
      ids.workspaceProject,
      ids.grant,
      intent,
      expect.objectContaining({
        manifestId: ids.manifest,
        signingPublicKey: Buffer.alloc(44, 1).toString("base64"),
        currentEntries: [entry],
        authority: {
          action: "workspace.memory.share_owned",
          source: "device_action_grant",
          referenceId: ids.grant
        }
      })
    );
    expect(item.startAttempt).toHaveBeenCalledTimes(1);
    expect(intent.commandRequestId).not.toBe(ids.grant);
    expect(item.startAttempt).toHaveBeenCalledWith(
      ids.personal,
      ids.backend,
      ids.workspaceProject,
      ids.grant,
      intent,
      expect.objectContaining({
        authority: {
          action: "workspace.memory.share_owned",
          source: "device_action_grant",
          referenceId: ids.grant
        }
      })
    );
    expect(item.finalizeAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not activate on an ambiguous consume response and never retries it", async () => {
    const item = fixture();
    item.consumeLocal.mockRejectedValueOnce(new Error("network result lost"));
    const prepared = await item.client.prepareEnable(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    item.finalizeAttempt
      .mockResolvedValueOnce({ state: "unknown" })
      .mockResolvedValueOnce({ state: "unknown" });
    await expect(
      item.client.enable(ids.personal, prepared, intent, ids.grant)
    ).rejects.toThrow("pending exact receipt recovery");
    expect(item.consumeLocal).toHaveBeenCalledTimes(1);
    expect(item.startAttempt).toHaveBeenCalledTimes(1);
    expect((await item.client.status(ids.personal)).pendingAction).toBe(
      "enable"
    );
  });

  it("recovers an exact consumed enable receipt read-only after a lost response", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    item.consumeLocal.mockImplementationOnce(async () => {
      item.setPolicy(policy("active", 1));
      throw new Error("network result lost");
    });
    const outcome = await item.client.enable(
      ids.personal,
      prepared,
      intent,
      ids.grant
    );
    expect(outcome.policy.status).toBe("active");
    expect(item.consumeLocal).toHaveBeenCalledTimes(1);
    expect(item.finalizeAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not adopt an obsolete link attempt or let it block a new review", async () => {
    const item = fixture();
    const oldAttempt = {
      attemptId: randomUUID(),
      action: "enable" as const,
      clientRequestId: randomUUID(),
      actionGrantId: randomUUID(),
      teamBackendId: "former-backend",
      workspaceProjectId: randomUUID(),
      teamId: randomUUID(),
      teamPrincipalUserId: randomUUID(),
      deviceCredentialId: randomUUID(),
      expectedPolicyVersion: 0,
      payloadHash: "a".repeat(64)
    };
    item.setPending([oldAttempt]);
    expect((await item.client.status(ids.personal)).pendingAction).toBeNull();
    expect(item.finalizeAttempt).not.toHaveBeenCalled();
    await expect(
      item.client.prepareEnable(ids.personal)
    ).resolves.toBeDefined();

    const currentAttempt = {
      ...oldAttempt,
      attemptId: randomUUID(),
      teamBackendId: ids.backend,
      workspaceProjectId: ids.workspaceProject,
      teamId: ids.team,
      teamPrincipalUserId: ids.principal
    };
    item.setPending([oldAttempt, currentAttempt]);
    item.finalizeAttempt.mockResolvedValueOnce({ state: "unknown" });
    expect((await item.client.status(ids.personal)).pendingAction).toBe(
      "enable"
    );
    expect(item.finalizeAttempt).toHaveBeenCalledExactlyOnceWith(
      ids.personal,
      ids.backend,
      currentAttempt.attemptId
    );
  });

  it("clears only an exact terminal grant without replaying the Team effect", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    item.consumeLocal.mockRejectedValueOnce(new Error("request failed"));
    item.finalizeAttempt.mockImplementationOnce(async () => {
      item.setPending([]);
      return { state: "terminal", reason: "expired" };
    });
    await expect(
      item.client.enable(ids.personal, prepared, intent, ids.grant)
    ).rejects.toThrow("did not execute");
    expect(item.consumeLocal).toHaveBeenCalledTimes(1);
    expect((await item.client.status(ids.personal)).pendingAction).toBeNull();
  });

  it("does not activate from a mismatched exact execution receipt", async () => {
    const item = fixture();
    const prepared = await item.client.prepareEnable(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_enable" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 0,
      manifestId: ids.manifest,
      manifestHash: initialManifestHash
    };
    item.consumeLocal.mockRejectedValueOnce(new Error("network result lost"));
    item.finalizeAttempt.mockResolvedValueOnce({
      state: "finalized",
      action: "enable",
      version: 99
    });
    await expect(
      item.client.enable(ids.personal, prepared, intent, ids.grant)
    ).rejects.toThrow("pending exact receipt recovery");
    expect(item.consumeLocal).toHaveBeenCalledTimes(1);
  });

  it("revokes only the current active Team policy and then clears local activation", async () => {
    const item = fixture();
    item.setPolicy(policy("active", 1));
    const prepared = await item.client.prepareRevoke(ids.personal);
    const intent = {
      intent: "collaboration.project_share_policy_revoke" as const,
      commandRequestId: randomUUID(),
      teamId: ids.team,
      projectId: ids.workspaceProject,
      expectedPolicyVersion: 1
    };
    const result = await item.client.revoke(
      ids.personal,
      prepared,
      intent,
      ids.grant
    );
    expect(result.status).toBe("revoked");
    expect(item.startAttempt).toHaveBeenCalledTimes(1);
    expect(item.finalizeAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries only stored approved Team sources and reports source drift without adoption", async () => {
    const item = fixture();
    item.setPolicy(policy("active", 1));
    item.setEntries([{ ...entry, sessionId: randomUUID() }]);
    item.stageLocal.mockRejectedValueOnce(
      Object.assign(new Error("source revision changed"), { statusCode: 409 })
    );
    const result = await item.client.stageInitial(ids.personal);
    expect(result.initialStage).toEqual({
      stagedCount: 0,
      skippedCount: 0,
      pendingCount: 0,
      needsReviewCount: 1,
      items: [
        {
          label: entry.reviewLabel,
          state: "needs_review",
          reason: "source_changed"
        }
      ]
    });
    expect(item.loadManifest).not.toHaveBeenCalled();
    expect(item.stageLocal).toHaveBeenCalledExactlyOnceWith(
      ids.personal,
      ids.backend,
      ids.workspaceProject,
      ids.session,
      1
    );
  });

  it("reports an ineligible reviewed source without attempting a new issue", async () => {
    const item = fixture();
    item.setPolicy({
      ...policy("active", 1),
      eligibleCount: 0,
      reviewSources: [
        {
          sessionId: ids.session,
          reviewLabel: entry.reviewLabel,
          eligible: false
        }
      ]
    });
    const result = await item.client.stageInitial(ids.personal);
    expect(result.initialStage).toEqual({
      stagedCount: 0,
      skippedCount: 1,
      pendingCount: 0,
      needsReviewCount: 0,
      items: [
        { label: entry.reviewLabel, state: "skipped", reason: "ineligible" }
      ]
    });
    expect(item.stageLocal).not.toHaveBeenCalled();
  });

  it("aborts a stage when Team policy authority changes before the effect", async () => {
    const item = fixture();
    item.setPolicy(policy("active", 1));
    item.sendPolicy
      .mockResolvedValueOnce(policy("active", 1))
      .mockResolvedValueOnce(policy("revoked", 2));
    await expect(item.client.stageInitial(ids.personal)).rejects.toThrow(
      "policy changed"
    );
    expect(item.stageLocal).not.toHaveBeenCalled();
  });

  it("does not mislabel a 409 caused by concurrent policy revocation as source drift", async () => {
    const item = fixture();
    item.setPolicy(policy("active", 1));
    item.sendPolicy
      .mockResolvedValueOnce(policy("active", 1))
      .mockResolvedValueOnce(policy("active", 1))
      .mockResolvedValueOnce(policy("revoked", 2));
    item.stageLocal.mockRejectedValueOnce(
      Object.assign(new Error("policy version changed"), { statusCode: 409 })
    );
    await expect(item.client.stageInitial(ids.personal)).rejects.toThrow(
      "policy changed"
    );
    expect(item.stageLocal).toHaveBeenCalledTimes(1);
  });

  it("labels a lost staging result pending and does not replay the mutation", async () => {
    const item = fixture();
    item.setPolicy(policy("active", 1));
    item.stageLocal.mockRejectedValueOnce(new Error("network result lost"));
    const result = await item.client.stageInitial(ids.personal);
    expect(result.initialStage).toEqual({
      stagedCount: 0,
      skippedCount: 0,
      pendingCount: 1,
      needsReviewCount: 0,
      items: [
        { label: entry.reviewLabel, state: "pending", reason: "result_unknown" }
      ]
    });
    expect(item.stageLocal).toHaveBeenCalledTimes(1);
  });
});
