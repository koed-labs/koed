import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  retentionAdminRequestHash,
  retentionAdminScopeHash
} from "../retention/routes.js";
import { teamAdminRequestHash, teamAdminScopeHash } from "../team/routes.js";
import { admitHighRiskActionGrant } from "./action-definitions.js";
import { ActionApprovalPolicyError } from "./approval-policy.js";
import type { HighRiskActionGrantIntent } from "./action-grant-protocol.js";

const ids = { actor: randomUUID(), team: randomUUID(), hold: randomUUID() };
const team = {
  id: ids.team,
  name: "Koed Team",
  version: 4,
  lifecycle: "active",
  entitlementStatus: "active"
};
const gate = {
  teamId: ids.team,
  version: 4,
  status: "active"
};
const seats = {
  teamId: ids.team,
  version: 3,
  seatLimit: 10,
  billableSeatCount: 7
};

const repository = () => ({
  getTeamEntitlementGate: vi.fn(async () => gate as never),
  getTeamBillingSeatState: vi.fn(async () => seats as never),
  getTeamMembership: vi.fn(async () => ({ role: "owner" }) as never),
  listTeams: vi.fn(async () => [team] as never),
  getLegalHoldApprovalReview: vi.fn(async () => ({
    id: ids.hold,
    teamId: ids.team,
    teamName: team.name,
    scope: "team",
    state: "active" as const
  }))
});

const admit = (intent: HighRiskActionGrantIntent, repo = repository()) =>
  admitHighRiskActionGrant({
    repository: repo as never,
    userId: ids.actor,
    clientRequestId: randomUUID(),
    hashSecret: (value) => value,
    intent
  });

describe("commercial and governance action definitions", () => {
  it("binds entitlement and billing policy to exact Team versions with Step-up", async () => {
    const entitlement = {
      action: "team.entitlement.update",
      teamId: ids.team,
      body: { expectedVersion: 4, status: "suspended", reason: "policy" }
    } as const satisfies HighRiskActionGrantIntent;
    const billing = {
      action: "team.billing_seats.update",
      teamId: ids.team,
      body: { expectedVersion: 3, seatLimit: 12 }
    } as const satisfies HighRiskActionGrantIntent;

    const entitlementResult = await admit(entitlement);
    const billingResult = await admit(billing);

    expect(entitlementResult).toMatchObject({
      operation: {
        teamId: ids.team,
        targetId: ids.team,
        scopeHash: teamAdminScopeHash({
          action: entitlement.action,
          teamId: ids.team,
          targetId: ids.team
        }),
        requestHash: teamAdminRequestHash({
          method: "PUT",
          path: `/v1/teams/${ids.team}/entitlement`,
          body: entitlement.body
        })
      },
      policy: { disposition: "step_up" }
    });
    expect(billingResult).toMatchObject({
      policy: {
        disposition: "step_up",
        review: {
          details: expect.arrayContaining([
            { label: "Current seat limit", value: "10" },
            { label: "Seat limit", value: "12" }
          ])
        }
      }
    });
  });

  it("rejects commercial governance admission for a Team admin", async () => {
    const repo = repository();
    repo.getTeamMembership.mockResolvedValue({ role: "admin" } as never);
    const intent = {
      action: "team.entitlement.update",
      teamId: ids.team,
      body: { expectedVersion: 4, status: "suspended", reason: "policy" }
    } as const satisfies HighRiskActionGrantIntent;

    await expect(admit(intent, repo)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
  });

  it("binds Team deletion to exact lifecycle and version with Step-up", async () => {
    const intent = {
      action: "team.retention.delete_request",
      teamId: ids.team,
      body: { expectedVersion: 4 }
    } as const satisfies HighRiskActionGrantIntent;

    const result = await admit(intent);

    expect(result).toMatchObject({
      operation: {
        scopeHash: retentionAdminScopeHash({
          action: intent.action,
          teamId: ids.team,
          targetId: ids.team
        }),
        requestHash: retentionAdminRequestHash({
          method: "POST",
          path: `/v1/retention/teams/${ids.team}/deletion-request`,
          body: intent.body
        })
      },
      policy: { disposition: "step_up" }
    });
  });

  it("keeps legal-hold placement and both exact release stages on separate Step-up decisions", async () => {
    const placement = {
      action: "team.legal_hold.place",
      body: {
        target: { scope: "team", teamId: ids.team },
        reasonCode: "litigation",
        reasonHash: "a".repeat(64)
      }
    } as const satisfies HighRiskActionGrantIntent;
    const request = {
      action: "team.legal_hold.release_request",
      holdId: ids.hold,
      body: {}
    } as const satisfies HighRiskActionGrantIntent;
    const confirm = {
      action: "team.legal_hold.release_confirm",
      holdId: ids.hold,
      body: { singleHolderReleaseException: false }
    } as const satisfies HighRiskActionGrantIntent;
    const repo = repository();

    const placed = await admit(placement, repo);
    const requested = await admit(request, repo);
    repo.getLegalHoldApprovalReview.mockResolvedValueOnce({
      id: ids.hold,
      teamId: ids.team,
      teamName: team.name,
      scope: "team",
      state: "release_pending"
    } as never);
    const confirmed = await admit(confirm, repo);

    expect(placed).toMatchObject({ policy: { disposition: "step_up" } });
    expect(requested).toMatchObject({
      operation: {
        action: request.action,
        targetId: ids.hold,
        path: `/v1/retention/legal-holds/${ids.hold}/release-request`
      },
      policy: { disposition: "step_up" }
    });
    expect(confirmed).toMatchObject({
      operation: {
        action: confirm.action,
        targetId: ids.hold,
        path: `/v1/retention/legal-holds/${ids.hold}/release-confirmation`
      },
      policy: { disposition: "step_up" }
    });
  });

  it("fails closed for missing authority, stale versions, Team lifecycle, and hold stage", async () => {
    const entitlement = {
      action: "team.entitlement.update",
      teamId: ids.team,
      body: { expectedVersion: 99, status: "suspended", reason: null }
    } as const satisfies HighRiskActionGrantIntent;
    await expect(admit(entitlement)).rejects.toBeInstanceOf(
      ActionApprovalPolicyError
    );
    const repo = repository();
    repo.getLegalHoldApprovalReview.mockResolvedValueOnce(null as never);
    await expect(
      admit(
        {
          action: "team.legal_hold.release_request",
          holdId: ids.hold,
          body: {}
        },
        repo
      )
    ).rejects.toBeInstanceOf(ActionApprovalPolicyError);
  });
});
