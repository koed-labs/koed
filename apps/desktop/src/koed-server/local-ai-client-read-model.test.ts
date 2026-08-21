import { describe, expect, it } from "vitest";

import { readLocalAiClientReadModel } from "./local-ai-client-read-model.js";

describe("local AI Client read model", () => {
  it("retains the executable model ID separately from its qualified label ID", () => {
    const model = readLocalAiClientReadModel(
      {
        instances: [],
        capabilitySnapshots: [
          {
            instanceId: "codex.default",
            authenticationState: "authenticated",
            healthState: "healthy",
            models: [
              {
                id: "gpt-5.6-luna",
                provider: "openai",
                model: "gpt-5.6-luna",
                fullId: "openai/gpt-5.6-luna",
                supportedReasoningEfforts: ["low"]
              }
            ],
            capabilities: {},
            observedAt: "",
            expiresAt: "",
            stale: true
          }
        ],
        settings: [],
        defaults: {}
      },
      {}
    );

    expect(model.capabilitySnapshots[0]?.models[0]).toMatchObject({
      id: "gpt-5.6-luna",
      fullId: "openai/gpt-5.6-luna"
    });
  });

  it("reads per-instance lifecycle capability descriptors and expiry", () => {
    const model = readLocalAiClientReadModel(
      {
        instances: [
          {
            instanceId: "claude.work",
            driverId: "claude",
            displayName: "Claude Work",
            enabled: true
          }
        ],
        capabilitySnapshots: [
          {
            instanceId: "claude.work",
            authenticationState: "authenticated",
            healthState: "healthy",
            models: [],
            capabilities: {
              descriptors: {
                managed_conversation_start: {
                  support: "supported",
                  readiness: "ready"
                },
                managed_conversation_send: {
                  support: "supported",
                  readiness: "ready"
                },
                handoff: {
                  support: "supported",
                  readiness: "not_ready"
                },
                fork: {
                  support: "unsupported",
                  readiness: "not_ready"
                }
              }
            },
            observedAt: "2026-07-27T00:00:00.000Z",
            expiresAt: "2026-07-27T00:10:00.000Z",
            stale: false
          }
        ],
        settings: [],
        defaults: {}
      },
      {}
    );

    expect(model.instances[0]).toMatchObject({
      instanceId: "claude.work",
      displayName: "Claude Work",
      enabled: true
    });
    expect(model.capabilitySnapshots[0]).toMatchObject({
      managedConversationStart: { support: "supported", readiness: "ready" },
      managedConversationSend: { support: "supported", readiness: "ready" },
      managedConversationHandoff: {
        support: "supported",
        readiness: "not_ready"
      },
      managedConversationFork: {
        support: "unsupported",
        readiness: "not_ready"
      },
      expiresAt: "2026-07-27T00:10:00.000Z"
    });
  });

  it("maps missing lifecycle descriptors to unknown instead of enabling controls", () => {
    const model = readLocalAiClientReadModel(
      {
        instances: [],
        capabilitySnapshots: [
          {
            instanceId: "codex.default",
            authenticationState: "unknown",
            healthState: "unavailable",
            capabilities: {},
            observedAt: "",
            expiresAt: "",
            stale: true
          }
        ],
        settings: [],
        defaults: {}
      },
      {}
    );

    expect(model.capabilitySnapshots[0]?.managedConversationStart).toEqual({
      support: "unknown",
      readiness: "unknown"
    });
    expect(model.capabilitySnapshots[0]?.managedConversationSend).toEqual({
      support: "unknown",
      readiness: "unknown"
    });
  });
});
