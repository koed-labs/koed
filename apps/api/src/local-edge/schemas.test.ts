import { describe, expect, it } from "vitest";

import {
  createDeviceEnrollmentChallengeSchema,
  localEdgeOperationFamilySchema,
  localEdgeTeamMemoryAnswerSchema,
  localEdgeTeamMemoryExpandSchema,
  localEdgeTeamMemoryQuestionSchema,
  localEdgeTeamMemorySearchSchema,
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

describe("local edge Team semantic recall schemas", () => {
  const teamWorkspaceId = "00000000-0000-4000-8000-000000000002";

  it.each([localEdgeTeamMemorySearchSchema, localEdgeTeamMemoryAnswerSchema])(
    "accepts Workspace-bound Team recall",
    (schema) => {
      expect(
        schema.safeParse({
          upstream_backend_id: "team-vps",
          input: {
            query: "retained decision",
            team_workspace_id: teamWorkspaceId
          }
        }).success
      ).toBe(true);
      expect(
        schema.safeParse({
          upstream_backend_id: "team-vps",
          input: { query: "retained decision" }
        }).success
      ).toBe(false);
    }
  );

  it("accepts only Workspace-bound candidate expansion", () => {
    expect(
      localEdgeTeamMemoryExpandSchema.safeParse({
        upstream_backend_id: "team-vps",
        node_id: "00000000-0000-4000-8000-000000000003",
        input: { team_workspace_id: teamWorkspaceId }
      }).success
    ).toBe(true);
    expect(
      localEdgeTeamMemoryExpandSchema.safeParse({
        upstream_backend_id: "team-vps",
        node_id: "00000000-0000-4000-8000-000000000003",
        input: {}
      }).success
    ).toBe(false);
  });

  it("requires a Workspace-bound final Team Memory Question", () => {
    const input = {
      upstream_backend_id: "team-vps",
      input: {
        idempotency_key: "question-1",
        query: "What did the Team decide?",
        origin: "mcp_memory_answer",
        retrieval_scope: "personal",
        team_workspace_id: teamWorkspaceId,
        status: "answered",
        answer_markdown: "Use the shared decision."
      }
    };
    expect(localEdgeTeamMemoryQuestionSchema.safeParse(input).success).toBe(
      true
    );
    expect(
      localEdgeTeamMemoryQuestionSchema.safeParse({
        ...input,
        input: { ...input.input, team_workspace_id: undefined }
      }).success
    ).toBe(false);
  });
});
