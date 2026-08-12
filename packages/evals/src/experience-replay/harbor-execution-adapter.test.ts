import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import type { CoordinatorTask } from "./coordinator.js";
import {
  HarborExecutionAdapter,
  createDeterministicSmokeTelemetry
} from "./harbor-execution-adapter.js";
import type {
  HarborRunRequest,
  SubprocessExecutor,
  SubprocessInvocation,
  SubprocessResult
} from "./harbor-client.js";
import type { HarborLifecycleCallbacks } from "./harbor-lifecycle.js";
import { assertCompleteReplayTelemetry } from "./telemetry.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const task: CoordinatorTask = {
  name: "terminal-bench/cad-model",
  taskDigest: `sha256:${"1".repeat(64)}`,
  category: "synthetic",
  expertTimeSeconds: 1,
  resourceClass: "synthetic-cpu",
  reward: { minimum: 0, maximum: 1, successValue: 1 }
};

const config = (runRoot: string) =>
  resolveExperienceReplayConfig({
    version: 1,
    profile: "smoke",
    seed: "adapter-smoke",
    output_dir: runRoot,
    codex_cli: {
      version: "deterministic-codex",
      host_sha256: "a".repeat(64),
      container_sha256: "a".repeat(64)
    },
    coding_agent: { id: "deterministic-codex", reasoning_effort: "low" },
    memory_answer: {
      model: { id: "deterministic", reasoning_effort: "low" },
      prompt_version: "v1",
      output_schema_version: "v1"
    },
    lcm_summary: {
      model: { id: "deterministic", reasoning_effort: "low" },
      prompt_version: "v1",
      output_schema_version: "v1"
    },
    session_title: {
      model: { id: "deterministic", reasoning_effort: "low" },
      prompt_version: "v1",
      output_schema_version: "v1"
    },
    embedding: {
      model: "deterministic",
      artifact_sha256: "b".repeat(64),
      tokenizer: "whitespace-v1",
      transform: "none-v1",
      dimensions: 4
    },
    price_table: {
      version: "v1",
      sha256: "c".repeat(64),
      models: {}
    },
    timeouts: {
      agent_seconds: 2,
      setup_seconds: 3,
      verifier_seconds: 5,
      preparation_seconds: 7,
      teardown_seconds: 11
    },
    admission: {
      maximum_trajectory_bytes: 1_000_000,
      estimated_attempt_artifact_bytes: 1,
      estimated_image_bytes_per_task: 0,
      scratch_multiplier: 1,
      minimum_free_space_reserve_bytes: 0,
      max_input_tokens_per_call: 1,
      max_output_tokens_per_call: 1,
      max_memory_answer_calls_per_attempt: 1,
      max_preparation_calls_per_source: 1
    }
  });

const lifecycleEvent = async (
  invocation: SubprocessInvocation,
  request: HarborRunRequest,
  event: "agent_started" | "agent_ended" | "trial_ended"
): Promise<void> => {
  const socketPath = invocation.env.KOED_HARBOR_LIFECYCLE_SOCKET;
  const token = invocation.env.KOED_HARBOR_LIFECYCLE_TOKEN;
  if (!socketPath || !token) throw new Error("missing lifecycle channel");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString("utf8")));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        expect(JSON.parse(response)).toEqual({
          schema_version: "koed-harbor-lifecycle-ack-v1",
          accepted: true
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => {
      socket.end(
        `${JSON.stringify({
          schema_version: "koed-harbor-lifecycle-v1",
          token,
          attempt_kind: request.attempt_kind,
          event,
          trial_id: `trial-${request.attempt_kind}`,
          task_name: request.task_name,
          timestamp: "2026-08-12T00:00:00.000Z"
        })}\n`
      );
    });
  });
};

interface ExecutorCapture {
  requests: HarborRunRequest[];
  invocations: SubprocessInvocation[];
}

const successfulExecutor =
  (
    capture: ExecutorCapture,
    options: { reward?: number; passed?: boolean } = {}
  ): SubprocessExecutor =>
  async (invocation) => {
    const requestPath = invocation.args.at(-1);
    if (!requestPath) throw new Error("missing request path");
    const serialized = await readFile(requestPath, "utf8");
    const request = JSON.parse(serialized) as HarborRunRequest;
    capture.requests.push(request);
    capture.invocations.push(invocation);

    await lifecycleEvent(invocation, request, "agent_started");
    await lifecycleEvent(invocation, request, "agent_ended");
    if (request.attempt_kind === "source") {
      const trajectory = `${JSON.stringify({
        schema_version: "ATIF-v1.7",
        session_id: "source",
        agent: { name: "codex", version: "deterministic" },
        steps: []
      })}\n`;
      const trajectoryPath = path.join(
        request.run_root,
        request.freeze_trajectory_to
      );
      await mkdir(path.dirname(trajectoryPath), { recursive: true });
      await writeFile(trajectoryPath, trajectory, { flag: "wx" });
      const manifest = {
        schema_version: "koed-harbor-freeze-v1",
        adapter: {
          name: "harbor-codex",
          version: "0.21.0",
          commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
          raw_reasoning_capture_disabled: true
        },
        source_attempt: {
          trial_id: "trial-source",
          task_name: request.task_name
        },
        lifecycle: [],
        cutoff: {
          agent_last_native_event_ordinal: null,
          step_identities: []
        },
        frozen_artifact: {
          relative_path: request.freeze_trajectory_to,
          sha256: digest(trajectory),
          size_bytes: Buffer.byteLength(trajectory),
          file_identity: { device: 1, inode: 1 }
        }
      };
      const manifestText = `${JSON.stringify(manifest)}\n`;
      const manifestPath = path.join(
        request.run_root,
        request.freeze_manifest_path
      );
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, manifestText, { flag: "wx" });
      (
        request as HarborRunRequest & { __manifestDigest?: string }
      ).__manifestDigest = digest(manifestText);
    }
    await lifecycleEvent(invocation, request, "trial_ended");

    const reward = options.reward ?? 1;
    const passed = options.passed ?? reward === 1;
    const output = {
      schema_version: "koed-harbor-result-v1",
      runtime: {
        harbor_version: "0.21.0",
        harbor_commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
        uv_lock_sha256: `sha256:${"2".repeat(64)}`
      },
      job_lock_sha256: `sha256:${"3".repeat(64)}`,
      ...(request.attempt_kind === "source"
        ? {
            freeze_manifest_sha256: (
              request as HarborRunRequest & { __manifestDigest: string }
            ).__manifestDigest
          }
        : {}),
      result: {
        job_id: `job-${request.attempt_kind}`,
        n_total_trials: 1,
        n_completed_trials: 1,
        n_errored_trials: 0,
        phase_timings: {
          setup_ms: 12.5,
          agent_ms: 34.25,
          verifier_ms: 5.75
        },
        interactions: { turns: 1, tool_calls: 0 },
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0
        },
        trials: [
          {
            trial_id: `trial-${request.attempt_kind}`,
            task_name: request.task_name,
            primary_reward: { field: "reward", value: reward, passed },
            errored: false
          }
        ]
      }
    };
    return {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify(output)}\n`,
      stderr: ""
    };
  };

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harbor-adapter-"));
  const runRoot = path.join(root, "run");
  await mkdir(runRoot);
  return { root, runRoot, corpusManifest: path.join(root, "corpus.json") };
};

const acknowledgedLifecycle = (events: string[]): HarborLifecycleCallbacks => ({
  onAgentStarted: () => {
    events.push("activate");
  },
  onAgentEnded: () => {
    events.push("revoke");
  },
  onTrialEnded: () => {
    events.push("ended");
  }
});

describe("HarborExecutionAdapter", () => {
  it("runs a source as one pinned HarborClient trial and freezes only the source", async () => {
    const { runRoot, corpusManifest } = await fixture();
    const capture: ExecutorCapture = { requests: [], invocations: [] };
    const events: string[] = [];
    const adapter = new HarborExecutionAdapter({
      mode: "smoke",
      corpusManifest,
      executor: successfulExecutor(capture),
      requestId: () => "source-request"
    });
    const result = await adapter.runSource({
      task,
      attemptId: `source:${task.taskDigest}`,
      executionGeneration: 1,
      runRoot,
      freezeTrajectoryPath: "source/cad/trajectory.json",
      freezeManifestPath: "source/cad/manifest.json",
      sanitizedTokenQuartile: 2,
      lifecycle: acknowledgedLifecycle(events),
      config: config(runRoot)
    });

    expect(events).toEqual(["activate", "revoke", "ended"]);
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]).toMatchObject({
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "source",
      task_name: task.name,
      task_image: `koed.invalid/cad-model@sha256:${"0".repeat(64)}`,
      freeze_trajectory_to: "source/cad/trajectory.json",
      freeze_manifest_path: "source/cad/manifest.json",
      job_config: {
        retry: { max_retries: 0 },
        agents: [
          {
            name: "codex",
            n_concurrent: 1,
            kwargs: { config: { approval_policy: "never" } }
          }
        ]
      }
    });
    expect(capture.invocations[0]?.timeoutMs).toBe(21_000);
    expect(result).toMatchObject({
      reward: 1,
      passed: true,
      sanitizedTokenQuartile: 2,
      result: {
        schemaVersion: "koed-harbor-execution-capture-v1",
        attemptKind: "source"
      }
    });
  });

  it("runs replay without freeze destinations and emits complete smoke telemetry", async () => {
    const { runRoot, corpusManifest } = await fixture();
    const capture: ExecutorCapture = { requests: [], invocations: [] };
    const token = "opaque-bridge-credential";
    const adapter = new HarborExecutionAdapter({
      mode: "smoke",
      corpusManifest,
      executor: successfulExecutor(capture)
    });
    const execution = await adapter.runReplay({
      task,
      condition: "relevant",
      repeat: 0,
      executionGeneration: 1,
      runRoot,
      bridgeUrl: "http://127.0.0.1:4321",
      bridgeToken: token,
      lifecycle: acknowledgedLifecycle([]),
      config: config(runRoot)
    });

    const request = capture.requests[0] as unknown as Record<string, unknown>;
    expect(request.attempt_kind).toBe("replay");
    expect(request).not.toHaveProperty("freeze_manifest_path");
    expect(request).not.toHaveProperty("freeze_trajectory_to");
    expect(JSON.stringify(request)).not.toContain(token);
    expect(request).toMatchObject({
      job_config: {
        agents: [
          {
            kwargs: {
              config: {
                mcp_servers: {
                  koed: {
                    bearer_token_env_var: "KOED_BENCHMARK_MCP_TOKEN",
                    enabled_tools: ["memory_answer"]
                  }
                }
              }
            }
          }
        ]
      }
    });
    expect(capture.invocations[0]?.env.KOED_BENCHMARK_MCP_TOKEN).toBe(token);
    expect(JSON.stringify(execution.result)).not.toContain(token);
    expect(() =>
      assertCompleteReplayTelemetry(execution.telemetry)
    ).not.toThrow();
    expect(execution.telemetry.harbor?.metrics).toMatchObject({
      reward: 1,
      passed: true,
      setupMs: 12.5,
      agentMs: 34.25,
      verifierMs: 5.75
    });
  });

  it("rejects rewards outside the task range or inconsistent success value", async () => {
    for (const invalid of [
      { reward: 2, passed: false },
      { reward: 0, passed: true }
    ]) {
      const { runRoot, corpusManifest } = await fixture();
      const capture: ExecutorCapture = { requests: [], invocations: [] };
      const adapter = new HarborExecutionAdapter({
        mode: "smoke",
        corpusManifest,
        executor: successfulExecutor(capture, invalid)
      });
      await expect(
        adapter.runReplay({
          task,
          condition: "cold",
          repeat: 0,
          executionGeneration: 1,
          runRoot,
          lifecycle: acknowledgedLifecycle([]),
          config: config(runRoot)
        })
      ).rejects.toThrow("CoordinatorTask contract");
    }
  });

  it("propagates cancellation and timeout controls through HarborClient", async () => {
    for (const terminationReason of ["cancelled", "timeout"] as const) {
      const { runRoot, corpusManifest } = await fixture();
      const controller = new AbortController();
      const executor = vi.fn<SubprocessExecutor>(
        async (invocation): Promise<SubprocessResult> => {
          expect(invocation.signal).toBe(controller.signal);
          return {
            exitCode: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            terminationReason
          };
        }
      );
      const adapter = new HarborExecutionAdapter({
        mode: "smoke",
        corpusManifest,
        executor
      });
      await expect(
        adapter.runReplay({
          task,
          condition: "cold",
          repeat: 0,
          executionGeneration: 1,
          runRoot,
          signal: controller.signal,
          lifecycle: acknowledgedLifecycle([]),
          config: config(runRoot)
        })
      ).rejects.toMatchObject({ category: terminationReason });
    }
  });

  it("requires protocol-backed smoke and forbids subprocess replacement in recorded mode", async () => {
    const { corpusManifest } = await fixture();
    expect(
      () => new HarborExecutionAdapter({ mode: "smoke", corpusManifest })
    ).toThrow("injected subprocess executor");
    expect(
      () =>
        new HarborExecutionAdapter({
          mode: "recorded",
          corpusManifest,
          executor: async () => ({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: ""
          })
        })
    ).toThrow("real Harbor subprocess executor");
    expect(
      () => new HarborExecutionAdapter({ mode: "recorded", corpusManifest })
    ).toThrow("preflight-approved task images");
  });

  it("builds all mandatory deterministic observer envelopes", () => {
    const identity = {
      taskDigest: task.taskDigest,
      condition: "cold",
      repeat: 0
    } as const;
    const telemetry = {
      identity,
      harbor: {
        identity,
        status: "available",
        metrics: {
          reward: 1,
          passed: true,
          setupMs: 1,
          agentMs: 2,
          verifierMs: 3,
          failureCategory: null,
          failureKind: null,
          failurePhase: null
        }
      } as const,
      ...createDeterministicSmokeTelemetry(identity)
    };
    expect(() => assertCompleteReplayTelemetry(telemetry)).not.toThrow();
  });

  it("reports deterministic Recall activity without inventing measurements", () => {
    const identity = {
      taskDigest: task.taskDigest,
      condition: "relevant",
      repeat: 0
    } as const;
    const telemetry = createDeterministicSmokeTelemetry(identity);
    expect(telemetry.codex?.metrics).toMatchObject({
      toolCalls: 1,
      mcpCalls: 1,
      memoryAnswerCalls: 1
    });
    expect(telemetry.koedRecall?.metrics).toMatchObject({
      searches: 1,
      evidenceCount: 1,
      projectionMs: null
    });
    expect(telemetry.processRss?.metrics).toEqual({
      apiBytes: null,
      runtimeBytes: null,
      workerBytes: null
    });
  });
});
