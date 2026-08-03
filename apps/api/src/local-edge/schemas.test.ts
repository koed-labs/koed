import { describe, expect, it } from "vitest";

import {
  createDeviceEnrollmentChallengeSchema,
  localEdgeOperationFamilySchema,
  redeemDeviceEnrollmentChallengeSchema
} from "./schemas.js";

const challenge = {
  challenge_hash: "c".repeat(32),
  upstream_backend_id: "team-vps",
  protocol_deployment_id: "00000000-0000-4000-8000-000000000001"
};

describe("local edge enrollment schemas", () => {
  it("accepts personal collaboration operation families", () => {
    expect(
      localEdgeOperationFamilySchema.parse("personal_collaboration_read")
    ).toBe("personal_collaboration_read");
    expect(
      localEdgeOperationFamilySchema.parse("personal_collaboration_write")
    ).toBe("personal_collaboration_write");
  });

  it("requires a non-empty operation-family allowlist", () => {
    expect(
      createDeviceEnrollmentChallengeSchema.safeParse(challenge).success
    ).toBe(false);
    expect(
      createDeviceEnrollmentChallengeSchema.safeParse({
        ...challenge,
        requested_operation_families: []
      }).success
    ).toBe(false);
    expect(
      createDeviceEnrollmentChallengeSchema.safeParse({
        ...challenge,
        requested_operation_families: ["*"]
      }).success
    ).toBe(false);
    expect(
      createDeviceEnrollmentChallengeSchema.safeParse({
        ...challenge,
        requested_operation_families: ["team_workspace_read"]
      }).success
    ).toBe(true);
  });

  it("rejects an explicitly empty credential scope", () => {
    expect(
      redeemDeviceEnrollmentChallengeSchema.safeParse({
        challenge_hash: "c".repeat(32),
        credential_key_id: "device-credential-key",
        verifier_kind: "secret_hash",
        verifier_secret: "s".repeat(32),
        operation_families: []
      }).success
    ).toBe(false);
  });
});
