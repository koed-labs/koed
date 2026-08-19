import { describe, expect, it } from "vitest";

import {
  aiClientCapabilitySnapshotSchema,
  aiClientDiagnosticSchema,
  aiClientInstanceParamsSchema,
  aiClientInstanceSchema,
  localMemoryAgentSettingsSchema
} from "./local-agent-settings-schemas.js";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  installation_identity_hash: "a".repeat(64),
  authentication_state: "authenticated",
  health_state: "healthy",
  models: [
    {
      id: "openai/gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      fullId: "openai/gpt-5.4",
      provenance: "reported",
      supportedReasoningEfforts: ["high"]
    }
  ],
  capabilities: {
    descriptors: {
      local_synthesis: {
        id: "local_synthesis",
        support: "supported",
        readiness: "ready",
        diagnostics: [],
        recoveryAction: {
          id: "check",
          label: "Check AI Client",
          available: true
        }
      }
    },
    diagnostics: []
  },
  observed_at: "2026-07-13T00:00:00.000Z",
  expires_at: "2026-07-13T01:00:00.000Z",
  ...overrides
});

describe("local AI Client settings schemas", () => {
  it("requires supported provider and does not default it", () => {
    expect(
      localMemoryAgentSettingsSchema.safeParse({
        model: "gpt-5.4",
        reasoning_effort: "high",
        timeout_ms: 10_000,
        max_attempts: 1
      }).success
    ).toBe(false);
    expect(
      localMemoryAgentSettingsSchema.safeParse({
        provider: "future-client",
        model: "gpt-5.4",
        reasoning_effort: "high",
        timeout_ms: 10_000,
        max_attempts: 1
      }).success
    ).toBe(false);
  });

  it("uses separate driver and instance identifier limits", () => {
    const tooLongDriverId = "a".repeat(97);
    const validDriverId = "a".repeat(96);
    const instanceId = `a${"b".repeat(127)}`;
    expect(
      aiClientInstanceSchema.safeParse({
        driver_id: tooLongDriverId,
        display_name: "Client"
      }).success
    ).toBe(false);
    expect(
      aiClientInstanceSchema.safeParse({
        driver_id: validDriverId,
        display_name: "Client"
      }).success
    ).toBe(true);
    expect(aiClientInstanceParamsSchema.safeParse({ instanceId }).success).toBe(
      true
    );
    expect(
      localMemoryAgentSettingsSchema.safeParse({
        provider: "codex",
        ai_client_instance_id: instanceId,
        model: "gpt-5.4",
        reasoning_effort: "high",
        timeout_ms: 10_000,
        max_attempts: 1
      }).success
    ).toBe(true);
    expect(instanceId).toHaveLength(128);
  });

  it("bounds diagnostic detail payloads", () => {
    expect(
      aiClientDiagnosticSchema.safeParse({
        code: "discovery_failed",
        message: "Discovery failed",
        severity: "error",
        details: { output: "x".repeat(8_193) }
      }).success
    ).toBe(false);
  });

  it("enforces descriptor IDs and strict descriptor children", () => {
    expect(
      aiClientCapabilitySnapshotSchema.safeParse(
        snapshot({
          models: [
            {
              id: "openai/gpt-5.4",
              provenance: "reported",
              unsupported: true
            }
          ]
        })
      ).success
    ).toBe(false);
    expect(
      aiClientCapabilitySnapshotSchema.safeParse(
        snapshot({
          capabilities: {
            descriptors: {
              wrong_key: {
                id: "local_synthesis",
                support: "supported",
                readiness: "ready",
                diagnostics: []
              }
            }
          }
        })
      ).success
    ).toBe(false);
    expect(
      aiClientCapabilitySnapshotSchema.safeParse(
        snapshot({
          capabilities: {
            descriptors: {
              local_synthesis: {
                id: "local_synthesis",
                support: "supported",
                readiness: "ready",
                diagnostics: [
                  { code: "x", message: "x", severity: "info", extra: true }
                ]
              }
            }
          }
        })
      ).success
    ).toBe(false);
  });
});
