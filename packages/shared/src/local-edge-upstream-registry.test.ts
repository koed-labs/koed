import { describe, expect, it } from "vitest";

import { readLocalEdgeUpstreamEnrollmentBinding } from "./local-edge-upstream-registry.js";

const backendId = "team-backend";
const firstCredential = "11111111-1111-4111-8111-111111111111";
const firstPrincipal = "22222222-2222-4222-8222-222222222222";
const currentCredential = "33333333-3333-4333-8333-333333333333";
const currentPrincipal = "44444444-4444-4444-8444-444444444444";

const readFixture = (value: unknown) =>
  readLocalEdgeUpstreamEnrollmentBinding(
    "/fixture/enrollments.json",
    backendId,
    {
      existsSync: () => true,
      readFileSync: (() =>
        JSON.stringify(
          value
        )) as unknown as typeof import("node:fs").readFileSync
    }
  );

describe("local-edge upstream enrollment binding", () => {
  it("returns the latest exchanged remote credential and principal identity", () => {
    expect(
      readFixture({
        schemaVersion: 1,
        enrollments: [
          {
            backendId,
            requestId: "first-enrollment",
            state: "exchanged",
            deviceCredentialId: firstCredential,
            principalUserId: firstPrincipal
          },
          {
            backendId,
            requestId: "current-enrollment",
            state: "exchanged",
            deviceCredentialId: currentCredential.toUpperCase(),
            principalUserId: currentPrincipal.toUpperCase()
          }
        ]
      })
    ).toEqual({
      backendId,
      enrollmentId: "current-enrollment",
      deviceCredentialId: currentCredential,
      principalUserId: currentPrincipal
    });
  });

  it("fails closed for absent, pending, or malformed enrollment state", () => {
    expect(
      readLocalEdgeUpstreamEnrollmentBinding(
        "/missing/enrollments.json",
        backendId,
        { existsSync: () => false }
      )
    ).toBeNull();
    expect(
      readFixture({
        schemaVersion: 1,
        enrollments: [
          {
            backendId,
            requestId: "pending-enrollment",
            state: "pending",
            deviceCredentialId: currentCredential,
            principalUserId: currentPrincipal
          }
        ]
      })
    ).toBeNull();
    expect(
      readFixture({
        schemaVersion: 1,
        enrollments: [
          {
            backendId,
            requestId: "bad-enrollment",
            state: "exchanged",
            deviceCredentialId: "not-a-uuid",
            principalUserId: currentPrincipal
          }
        ]
      })
    ).toBeNull();
    expect(readFixture({ schemaVersion: 2, enrollments: [] })).toBeNull();
  });
});
