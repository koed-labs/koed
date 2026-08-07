import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readCollaborationActionGrantCustodyCommitmentHash } from "@koed/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCollaborationActionGrantLifecycle,
  type ActionGrantRemoteStatus
} from "./collaboration-action-grant-lifecycle.js";

const temporaryHomes: string[] = [];

const temporaryHome = (): string => {
  const home = mkdtempSync(resolve(tmpdir(), "koed-action-grant-lifecycle-"));
  temporaryHomes.push(home);
  return home;
};

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

const ids = {
  reference: "00000000-0000-4000-8000-000000000001",
  otherReference: "00000000-0000-4000-8000-000000000002",
  device: "00000000-0000-4000-8000-000000000003",
  otherDevice: "00000000-0000-4000-8000-000000000004",
  principal: "00000000-0000-4000-8000-000000000005",
  otherPrincipal: "00000000-0000-4000-8000-000000000006",
  team: "00000000-0000-4000-8000-000000000007",
  idempotency: "00000000-0000-4000-8000-000000000008"
} as const;
const selector = "00000000-0000-4000-8000-000000000009";

const backend = {
  id: "team-vps",
  baseUrl: "https://team.example.test/koed",
  routePolicy: {}
};

const context = {
  backend,
  principalUserId: ids.principal,
  upstreamDeviceCredentialId: ids.device
};

const operation = {
  operationFamily: "admin" as const,
  action: "team.workspace.create",
  teamId: ids.team,
  targetId: null,
  method: "POST" as const,
  path: `/v1/teams/${ids.team}/workspaces`,
  body: { name: "Research", description: "Shared research" },
  idempotencyKey: ids.idempotency
};

const review = {
  version: 1 as const,
  title: "Create Workspace?",
  description: "Review the exact Workspace creation request.",
  consequence: "A new shared Workspace will be created.",
  confirmLabel: "Create Workspace",
  details: [{ label: "Team", value: "Koed Team" }]
};

const approvedStatus = (
  overrides: Partial<ActionGrantRemoteStatus> = {}
): ActionGrantRemoteStatus => ({
  version: 1,
  actionGrant: { id: ids.reference },
  approvalTier: "step_up",
  review,
  state: "approved",
  activationUrl: null,
  expiresAt: "2026-08-04T12:05:00.000Z",
  ...overrides
});

const remoteEnvelope = (status: ActionGrantRemoteStatus) => ({
  status: {
    version: status.version,
    actionGrant: status.actionGrant,
    selector,
    approvalTier: status.approvalTier,
    review: status.review,
    state: status.state,
    activationPath:
      status.activationUrl === null
        ? null
        : `/v1/high-risk/browser-activations/${selector}`,
    expiresAt: status.expiresAt
  }
});

const createFixture = () => {
  const koedHome = temporaryHome();
  const now = { value: new Date("2026-08-04T12:00:00.000Z") };
  const lifecycle = createCollaborationActionGrantLifecycle({
    koedHome,
    now: () => now.value,
    randomBytes: (size) => Buffer.alloc(size, 0x41),
    ambiguousResponseWindowMs: 30_000
  });
  const custody = {
    referenceId: ids.reference,
    backendId: backend.id,
    deploymentBaseUrl: backend.baseUrl,
    deviceCredentialId: ids.device,
    principalUserId: ids.principal,
    ...operation,
    expiresAt: "2026-08-04T12:05:00.000Z"
  };
  const resolveInput = {
    referenceId: ids.reference,
    backendId: backend.id,
    deploymentBaseUrl: backend.baseUrl,
    deviceCredentialId: ids.device,
    principalUserId: ids.principal,
    ...operation
  };
  return { koedHome, now, lifecycle, custody, resolveInput };
};

const createApprovedFixture = () => {
  const fixture = createFixture();
  fixture.lifecycle.create(fixture.custody);
  fixture.lifecycle.acceptRemote(
    context,
    { id: ids.reference },
    remoteEnvelope(approvedStatus())
  );
  return fixture;
};

describe("collaboration Action Grant lifecycle", () => {
  it("durably stores unclassified custody before accepting remote classification", () => {
    const { koedHome, now, lifecycle, custody, resolveInput } = createFixture();

    const created = lifecycle.create(custody);

    expect(created).toEqual({
      referenceId: ids.reference,
      commitmentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(created).not.toHaveProperty("secret");
    expect(lifecycle.read(context, { id: ids.reference })).toBeNull();
    expect(lifecycle.resolve(resolveInput)).toBeNull();
    expect(
      readCollaborationActionGrantCustodyCommitmentHash(
        koedHome,
        {
          referenceId: ids.reference,
          backendId: backend.id,
          deploymentBaseUrl: backend.baseUrl,
          deviceCredentialId: ids.device,
          principalUserId: ids.principal
        },
        { now: () => now.value }
      )
    ).toBe(created.commitmentHash);
  });

  it("does not fabricate classification from a mismatched response and reconciles from an exact response", () => {
    const { lifecycle, custody, resolveInput } = createFixture();
    lifecycle.create(custody);

    expect(
      lifecycle.acceptRemote(
        context,
        { id: ids.reference },
        remoteEnvelope(
          approvedStatus({ actionGrant: { id: ids.otherReference } })
        )
      )
    ).toBeNull();
    expect(lifecycle.read(context, { id: ids.reference })).toBeNull();
    expect(lifecycle.resolve(resolveInput)).toBeNull();

    expect(
      lifecycle.acceptRemote(
        context,
        { id: ids.reference },
        remoteEnvelope(approvedStatus())
      )
    ).toEqual(approvedStatus());
    expect(lifecycle.resolve(resolveInput)).toMatch(/^hrg_/);
  });

  it("keeps malformed remote responses unclassified", () => {
    const { lifecycle, custody, resolveInput } = createFixture();
    lifecycle.create(custody);

    expect(
      lifecycle.acceptRemote(context, { id: ids.reference }, { status: {} })
    ).toBeNull();
    expect(lifecycle.read(context, { id: ids.reference })).toBeNull();
    expect(lifecycle.resolve(resolveInput)).toBeNull();
  });

  it("classifies schema-valid Step-up and Native-review states without local policy inference", () => {
    const stepUp = createFixture();
    stepUp.lifecycle.create(stepUp.custody);
    const pending = approvedStatus({
      state: "pending",
      activationUrl: `https://team.example.test/koed/v1/high-risk/browser-activations/${selector}`
    });
    expect(
      stepUp.lifecycle.acceptRemote(
        context,
        { id: ids.reference },
        remoteEnvelope(pending)
      )
    ).toMatchObject({ state: "pending", approvalTier: "step_up" });

    const native = createFixture();
    native.lifecycle.create(native.custody);
    const reviewRequired = approvedStatus({
      approvalTier: "native_review",
      state: "review_required"
    });
    expect(
      native.lifecycle.acceptRemote(
        context,
        { id: ids.reference },
        remoteEnvelope(reviewRequired)
      )
    ).toMatchObject({
      state: "review_required",
      approvalTier: "native_review"
    });
  });

  it("uses one ambiguity and reconciliation path for known remote states", () => {
    const { lifecycle, resolveInput } = createApprovedFixture();

    lifecycle.markAmbiguous(context, { id: ids.reference }, approvedStatus());
    expect(lifecycle.resolve(resolveInput)).toBeNull();

    lifecycle.acceptRemote(
      context,
      { id: ids.reference },
      remoteEnvelope(approvedStatus())
    );
    expect(lifecycle.resolve(resolveInput)).toMatch(/^hrg_/);
  });

  it.each(["consumed", "denied", "revoked", "expired", "canceled"] as const)(
    "removes custody for authoritative %s status",
    (state) => {
      const { lifecycle, resolveInput } = createApprovedFixture();

      expect(
        lifecycle.acceptRemote(
          context,
          { id: ids.reference },
          remoteEnvelope(approvedStatus({ state }))
        )
      ).toMatchObject({ state });
      expect(lifecycle.read(context, { id: ids.reference })).toBeNull();
      expect(lifecycle.resolve(resolveInput)).toBeNull();
    }
  );

  it.each([
    ["operation", { path: "/v1/teams/not-the-bound-team/workspaces" }],
    ["backend", { backendId: "other-vps" }],
    ["deployment", { deploymentBaseUrl: "https://other.example.test/koed" }],
    ["device", { deviceCredentialId: ids.otherDevice }],
    ["principal", { principalUserId: ids.otherPrincipal }],
    ["commitment request", { body: { name: "Different" } }]
  ] as const)("rejects a mismatched %s binding", (_label, mismatch) => {
    const { lifecycle, resolveInput } = createApprovedFixture();

    expect(lifecycle.resolve({ ...resolveInput, ...mismatch })).toBeNull();
  });

  it("returns the secret only for the exact approved binding", () => {
    const { lifecycle, resolveInput } = createApprovedFixture();

    expect(lifecycle.resolve(resolveInput)).toMatch(/^hrg_/);
  });
});
