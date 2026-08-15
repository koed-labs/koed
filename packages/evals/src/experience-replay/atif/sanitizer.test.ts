import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AtifSanitizationError,
  sanitizeAtifTrajectory,
  type AtifSanitizationOptions
} from "./sanitizer.js";

const options = (
  raw: string,
  steps: number,
  overrides: Partial<AtifSanitizationOptions> = {}
) => ({
  taskDigest: "sha256:task",
  sourceAttemptId: "source-1",
  countEmbeddingTokens: (text: string) =>
    text.length === 0 ? 0 : text.split(/\s+/).length,
  freezeManifest: {
    schema_version: "koed-harbor-freeze-v1" as const,
    adapter: {
      name: "harbor-codex" as const,
      version: "0.21.0",
      commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
      raw_reasoning_capture_disabled: true as const
    },
    source_attempt: {
      trial_id: "trial-1",
      task_name: "terminal-bench/cad-model"
    },
    lifecycle: [
      {
        ordinal: 1,
        event: "agent_started" as const,
        timestamp: "2026-08-12T00:00:00Z"
      },
      {
        ordinal: 2,
        event: "agent_ended" as const,
        timestamp: "2026-08-12T00:01:00Z"
      },
      {
        ordinal: 3,
        event: "trajectory_materialized" as const,
        timestamp: "2026-08-12T00:01:01Z"
      },
      {
        ordinal: 4,
        event: "verification_started" as const,
        timestamp: "2026-08-12T00:01:01Z"
      }
    ],
    cutoff: {
      agent_last_native_event_ordinal: steps,
      step_identities: Array.from({ length: steps }, (_, index) => ({
        step_id: index + 1,
        identity_sha256: `sha256:${createHash("sha256")
          .update(`${index + 1}:${index + 1}`)
          .digest("hex")}`,
        last_native_event_ordinal: index + 1
      }))
    },
    frozen_artifact: {
      relative_path: "artifacts/trajectory.json",
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      size_bytes: Buffer.byteLength(raw),
      file_identity: { device: 1, inode: 2 }
    }
  },
  ...overrides
});

const trajectory = () => ({
  schema_version: "ATIF-v1.7",
  session_id: "session-1",
  agent: {
    name: "codex",
    version: "1.2.3",
    model_name: "removed-model",
    extra: { cwd: "/workspace" }
  },
  notes: "removed notes",
  final_metrics: { total_steps: 3 },
  extra: { verifier_metadata: "removed" },
  steps: [
    {
      step_id: 1,
      timestamp: "2026-08-12T00:00:00Z",
      source: "user",
      message: "Fix the task."
    },
    {
      step_id: 2,
      timestamp: "2026-08-12T00:00:01Z",
      source: "agent",
      message: "I will inspect it.",
      reasoning_content: "Inspect first.",
      model_name: "removed-model",
      metrics: { prompt_tokens: 10 },
      extra: { api_call_id: "api_call_1" },
      tool_calls: [
        {
          tool_call_id: "call-1",
          function_name: "shell",
          arguments: { command: "pwd", api_key: "sk-abcdefghijk" } as Record<
            string,
            unknown
          >,
          extra: { status: "completed" } as Record<string, unknown>
        }
      ],
      observation: {
        results: [
          {
            source_call_id: "call-1",
            content: "/workspace",
            extra: { duration: 1 }
          }
        ]
      }
    },
    {
      step_id: 3,
      source: "agent",
      message: "Done."
    }
  ]
});

const sanitize = (
  value: unknown,
  overrides: Partial<AtifSanitizationOptions> = {}
) => {
  const raw = JSON.stringify(value);
  const stepCount = Array.isArray((value as { steps?: unknown }).steps)
    ? (value as { steps: unknown[] }).steps.length
    : 0;
  return sanitizeAtifTrajectory(raw, options(raw, stepCount, overrides));
};

const rejection = (
  value: unknown,
  overrides: Partial<AtifSanitizationOptions> = {}
): AtifSanitizationError => {
  try {
    sanitize(value, overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(AtifSanitizationError);
    return error as AtifSanitizationError;
  }
  throw new Error("expected sanitization to reject");
};

describe("strict ATIF-v1.7 sanitization", () => {
  it("allowlists structure, redacts whole typed credentials, and records a manifest", () => {
    const result = sanitize(trajectory());

    expect(result.trajectory).not.toHaveProperty("notes");
    expect(result.trajectory.agent).toEqual({
      name: "codex",
      version: "1.2.3"
    });
    expect(result.trajectory.steps[1]?.tool_calls?.[0]?.arguments).toEqual({
      command: "pwd",
      api_key: "[REDACTED_API_KEY_1]"
    });
    expect(result.manifest).toMatchObject({
      schemaVersion: "ATIF-v1.7",
      cutoffAttested: true,
      rejectionReason: null,
      redactionCounts: { API_KEY: 1 }
    });
    expect(result.manifest.removedFieldCounts).toMatchObject({
      "root.notes": 1,
      "root.final_metrics": 1,
      "root.extra": 1,
      "agent.model_name": 1,
      "step.metrics": 1,
      "tool_call.extra": 1,
      "result.extra": 1
    });
    expect(result.manifest.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps a multi-item agent step in normative stable sub-order", () => {
    const value = trajectory();
    const agentStep = value.steps[1]!;
    agentStep.tool_calls!.push({
      tool_call_id: "call-2",
      function_name: "shell",
      arguments: { command: "ls" },
      extra: { status: "completed" }
    });
    agentStep.observation!.results.push({
      source_call_id: "call-2",
      content: "README.md",
      extra: { duration: 1 }
    });

    const first = sanitize(value);
    const second = sanitize(value);
    expect(first.normalizedItems.map((item) => item.type)).toEqual([
      "user_message",
      "agent_message",
      "reasoning_summary",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "agent_message"
    ]);
    expect(first.normalizedItems.map((item) => item.sourceIdentity)).toEqual(
      second.normalizedItems.map((item) => item.sourceIdentity)
    );
    expect(first.normalizedItems[3]?.sourceCallId).toBe("call-1");
    expect(first.normalizedItems[5]?.sourceCallId).toBe("call-1");
  });

  it("rejects duplicate JSON keys before object materialization", () => {
    const raw = '{"schema_version":"ATIF-v1.7","schema_version":"ATIF-v1.6"}';
    expect(() => sanitizeAtifTrajectory(raw, options(raw, 0))).toThrowError(
      /DUPLICATE_OBJECT_KEY/
    );
  });

  it.each([
    ["unknown schema", { schema_version: "ATIF-v1.6" }, "UNSUPPORTED_SCHEMA"],
    ["unknown role", { source: "assistant" }, "UNKNOWN_STEP_SOURCE"],
    [
      "multimodal content",
      { message: [{ type: "text", text: "x" }] },
      "MULTIMODAL_MESSAGE"
    ],
    ["unknown field", { surprise: true }, "UNKNOWN_FIELD"]
  ])("rejects %s", (_name, replacement, reason) => {
    const value = trajectory();
    if ("schema_version" in replacement) Object.assign(value, replacement);
    else Object.assign(value.steps[0]!, replacement);
    expect(rejection(value).reason).toContain(reason);
  });

  it("rejects continuations and embedded or referenced subagent trajectories", () => {
    const continuation = trajectory();
    Object.assign(continuation, { continued_trajectory_ref: "next.json" });
    expect(rejection(continuation).reason).toBe("CONTINUATION_TRAJECTORY");

    const embedded = trajectory();
    Object.assign(embedded, { subagent_trajectories: [] });
    expect(rejection(embedded).reason).toBe("EMBEDDED_SUBAGENT_TRAJECTORY");

    const referenced = trajectory();
    Object.assign(referenced.steps[1]!.observation!.results[0]!, {
      subagent_trajectory_ref: [{ trajectory_path: "child.json" }]
    });
    expect(rejection(referenced).reason).toBe("SUBAGENT_TRAJECTORY_REFERENCE");
  });

  it("fails closed for embedded credentials but redacts an entire credential string", () => {
    const embedded = trajectory();
    embedded.steps[2]!.message = "Use sk-abcdefghijk to continue";
    expect(rejection(embedded).reason).toBe("UNSAFE_EMBEDDED_CREDENTIAL");

    const whole = trajectory();
    whole.steps[2]!.message = "Bearer abcdefghijklmnop";
    const result = sanitize(whole);
    expect(result.trajectory.steps[2]?.message).toBe(
      "[REDACTED_BEARER_TOKEN_1]"
    );
  });

  it("does not treat a credential-like suffix inside an identifier as a key", () => {
    const value = trajectory();
    value.steps[2]!.message =
      "Apply the koed-memory-eval-task-instruction-v2 policy";

    expect(() => sanitize(value)).not.toThrow();
  });

  it("allows Koed tool identifiers while rejecting Koed API keys", () => {
    const identifier = trajectory();
    identifier.steps[1]!.tool_calls![0]!.arguments = {
      input: "Call mcp__koed__memory_answer once"
    };
    identifier.steps[1]!.observation!.results[0]!.content =
      "Available tool: mcp__koed__memory_answer";
    expect(() => sanitize(identifier)).not.toThrow();

    for (const secret of ["koed_abcdefghijk", "koed_live_abcdefghijk"]) {
      const value = trajectory();
      value.steps[2]!.message = `Use ${secret} to continue`;
      expect(rejection(value).reason).toBe("UNSAFE_EMBEDDED_CREDENTIAL");
    }
  });

  it("rejects unresolved, duplicate, and cross-step tool linkage", () => {
    const unresolved = trajectory();
    unresolved.steps[1]!.observation!.results[0]!.source_call_id = "missing";
    expect(rejection(unresolved).reason).toBe(
      "UNRESOLVED_OR_CROSS_STEP_CALL_ID"
    );

    const duplicate = trajectory();
    duplicate.steps[1]!.tool_calls!.push({
      tool_call_id: "call-1",
      function_name: "shell",
      arguments: {},
      extra: {}
    });
    expect(rejection(duplicate).reason).toBe("DUPLICATE_TOOL_CALL_ID");
  });

  it("requires semantic lifecycle ordering and rejects post-cutoff events", () => {
    const value = trajectory();
    const badCutoff = options(JSON.stringify(value), 3);
    badCutoff.freezeManifest.cutoff.agent_last_native_event_ordinal = 2;
    expect(
      rejection(value, { freezeManifest: badCutoff.freezeManifest }).reason
    ).toBe("POST_AGENT_NATIVE_EVENT");

    const late = trajectory();
    late.steps[2]!.timestamp = "2026-08-12T00:02:00Z";
    expect(rejection(late).reason).toBe("POST_AGENT_STEP_TIMESTAMP");
  });

  it("verifies the frozen input identity and never accepts caller-only cutoff fields", () => {
    const value = trajectory();
    const raw = JSON.stringify(value);
    const proof = options(raw, 3).freezeManifest;
    proof.frozen_artifact.sha256 = `sha256:${"0".repeat(64)}`;
    expect(rejection(value, { freezeManifest: proof }).reason).toBe(
      "FROZEN_ARTIFACT_MISMATCH"
    );

    const badStepProof = options(raw, 3).freezeManifest;
    badStepProof.cutoff.step_identities[1]!.identity_sha256 = `sha256:${"f".repeat(64)}`;
    expect(rejection(value, { freezeManifest: badStepProof }).reason).toBe(
      "INVALID_STEP_IDENTITY"
    );

    expect(
      rejection(value, {
        freezeManifest: undefined,
        cutoff: {
          adapterName: "harbor-codex",
          adapterVersion: "0.21.0",
          rawReasoningCaptureDisabled: true,
          agentPhaseEndedOrdinal: 10,
          trajectoryMaterializedOrdinal: 11,
          verificationStartedOrdinal: 12,
          stepLastNativeEventOrdinals: [1, 2, 3]
        }
      }).reason
    ).toBe("MISSING_FREEZE_MANIFEST");
  });

  it("enforces structural and aggregate text limits", () => {
    const value = trajectory();
    expect(rejection(value, { limits: { steps: 2 } }).reason).toBe(
      "STEP_LIMIT"
    );
    expect(rejection(value, { limits: { allowedTextTokens: 2 } }).reason).toBe(
      "ALLOWED_TOKEN_LIMIT"
    );

    expect(rejection(value, { limits: { rawBytes: 20 } }).reason).toBe(
      "RAW_JSON_LIMIT"
    );
    expect(rejection(value, { limits: { stringBytes: 17 } }).reason).toBe(
      "STRING_LIMIT"
    );
    expect(rejection(value, { limits: { nestedValues: 10 } }).reason).toBe(
      "NESTED_VALUE_LIMIT"
    );
    expect(rejection(value, { limits: { allowedTextBytes: 10 } }).reason).toBe(
      "ALLOWED_TEXT_LIMIT"
    );

    const nested = trajectory();
    nested.steps[1]!.tool_calls![0]!.arguments = {
      command: { one: { two: { three: "pwd" } } }
    };
    expect(rejection(nested, { limits: { nestingDepth: 6 } }).reason).toBe(
      "NESTING_DEPTH_LIMIT"
    );
  });

  it("rejects known verifier paths but not ordinary mentions", () => {
    const mention = trajectory();
    mention.steps[2]!.message = "The verifier and tests should still pass.";
    expect(() => sanitize(mention)).not.toThrow();

    const path = trajectory();
    path.steps[2]!.message = "Read /logs/verifier/reward.txt";
    expect(rejection(path).reason).toBe("PROHIBITED_PATH");
  });

  it.each([
    ["X-API-Key", "secret-value-123"],
    ["Proxy-Authorization", "Basic dXNlcjpwYXNz"],
    ["aws_secret_access_key", "abc/DEF+secret123456789"],
    ["npmToken", "npm_abcdefghijklmnopqrstuvwxyz"],
    ["slack_token", ["xoxb", "1234567890", "abcdefghij"].join("-")],
    ["github_token", "github_pat_abcdefghijk"],
    ["koed_token", "koed_live_abcdefghijk"],
    ["Cookie", "sessionid=abcdefghijk"]
  ])("redacts credential-bearing key %s", (key, secret) => {
    const value = trajectory();
    value.steps[1]!.tool_calls![0]!.arguments = { [key]: secret };
    const result = sanitize(value);
    expect(
      Object.values(result.trajectory.steps[1]!.tool_calls![0]!.arguments)[0]
    ).toMatch(/^\[REDACTED_/);
    expect(result.canonicalJson).not.toContain(secret);
  });

  it.each([
    "Leaked key: -----BEGIN PRIVATE KEY-----\nabcdefghijk\n-----END PRIVATE KEY-----",
    "postgresql://alice:supersecret@db.example/koed",
    "X-API-Key: secret-value-123",
    "Proxy-Authorization: Basic dXNlcjpwYXNz",
    "token=abcdefghijk; Path=/",
    `Use ${["xoxb", "1234567890", "abcdefghij"].join("-")} now`,
    "Connect with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"
  ])("rejects embedded secret form without echoing it: %s", (secret) => {
    const value = trajectory();
    value.steps[2]!.message = secret;
    const error = rejection(value);
    expect(error.reason).toBe("UNSAFE_EMBEDDED_CREDENTIAL");
    expect(error.message).not.toContain(secret);
  });

  it("detects hidden-test path components without keyword false positives", () => {
    const prose = trajectory();
    prose.steps[2]!.message =
      "Discuss hidden tests, private tests, solutions, and verifier behavior.";
    expect(() => sanitize(prose)).not.toThrow();

    for (const hiddenPath of [
      "../../.hidden-tests/case.json",
      "./private_tests/answers.txt",
      "C:\\work\\held-out-tests\\case.txt"
    ]) {
      const value = trajectory();
      value.steps[2]!.message = `Read ${hiddenPath}`;
      expect(rejection(value).reason).toBe("PROHIBITED_PATH");
    }
  });

  it("does not treat dot-separated CAD data as a JWT", () => {
    const value = trajectory();
    value.steps[2]!.message =
      "STEP geometry identifiers 12345678.12345678.12345678 are not credentials.";
    expect(() => sanitize(value)).not.toThrow();
  });

  it("parses long numeric tokens with a linear scanner and rejects overflow", () => {
    const raw = `{"schema_version":"ATIF-v1.7","agent":{"name":"codex","version":"1"},"steps":[{"step_id":1,"source":"user","message":"x","extra":{"n":${"9".repeat(100_000)}}}]}`;
    expect(() => sanitizeAtifTrajectory(raw, options(raw, 1))).toThrowError(
      /NON_FINITE_NUMBER/
    );
  });
});
