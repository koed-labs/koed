import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import {
  startLocalAiRuntime,
  type LocalAiRuntimeServiceFactory,
  type LocalAiRuntimeToolExecutor
} from "@koed/mcp-server/runtime-contracts";
import type {
  HarborRunRequest,
  SubprocessExecutor,
  SubprocessInvocation
} from "./harbor-client.js";
import type { ProductRuntimeDependencies } from "./product-runtime.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const safeId = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);

const lifecycle = async (
  invocation: SubprocessInvocation,
  request: HarborRunRequest,
  event: "agent_started" | "agent_ended" | "trial_ended"
): Promise<void> => {
  const socketPath = invocation.env.KOED_HARBOR_LIFECYCLE_SOCKET;
  const token = invocation.env.KOED_HARBOR_LIFECYCLE_TOKEN;
  if (!socketPath || !token)
    throw new Error("Deterministic Harbor lifecycle channel is absent");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    socket.on("data", (chunk) => {
      if (settled) return;
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as {
          accepted?: unknown;
        };
        if (parsed.accepted !== true)
          throw new Error("Lifecycle event was not acknowledged");
        socket.destroy();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(
          error instanceof Error
            ? error
            : new Error("Lifecycle acknowledgement parsing failed", {
                cause: error
              })
        );
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!settled) reject(new Error("Lifecycle acknowledgement was empty"));
    });
    socket.once("connect", () => {
      socket.end(
        `${JSON.stringify({
          schema_version: "koed-harbor-lifecycle-v1",
          token,
          attempt_kind: request.attempt_kind,
          event,
          trial_id: `smoke-${request.attempt_kind}-${safeId(request.task_name)}`,
          task_name: request.task_name,
          timestamp: new Date().toISOString()
        })}\n`
      );
    });
  });
};

const bridgeUrl = (request: HarborRunRequest): string | undefined => {
  const agent = (
    request.job_config.agents as
      | Array<{ kwargs?: { config?: { mcp_servers?: unknown } } }>
      | undefined
  )?.[0];
  const servers = agent?.kwargs?.config?.mcp_servers as
    | { koed?: { url?: unknown } }
    | undefined;
  return typeof servers?.koed?.url === "string" ? servers.koed.url : undefined;
};

const callSmokeMemoryAnswer = async (
  url: string,
  token: string,
  taskName: string
): Promise<Record<string, unknown>> => {
  const client = new Client(
    { name: "koed-experience-replay-smoke", version: "1.0.0" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } }
    }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: () => Promise.resolve(token) }
  });
  await client.connect(transport);
  try {
    const response = await client.callTool({
      name: "memory_answer",
      arguments: { query: `smoke evidence for ${taskName}` }
    });
    if (response.isError)
      throw new Error("Deterministic smoke Memory Answer failed");
    if (
      !response.structuredContent ||
      typeof response.structuredContent !== "object"
    )
      throw new Error(
        "Deterministic smoke Memory Answer lacked structured content"
      );
    return response.structuredContent as Record<string, unknown>;
  } finally {
    await client.close();
  }
};

const replayCondition = (request: HarborRunRequest): string => {
  const jobName = request.job_config.job_name;
  if (typeof jobName !== "string")
    throw new Error("Deterministic replay job name is absent");
  const match = /-(cold|empty|placebo|relevant)-\d+-\d+$/u.exec(jobName);
  if (!match) throw new Error("Deterministic replay condition is absent");
  return match[1]!;
};

const assertSmokeRecallBoundary = (
  request: HarborRunRequest,
  answer: Record<string, unknown>
): void => {
  const condition = replayCondition(request);
  const found = answer.relevant_memory_found === true;
  const serialized = JSON.stringify(answer);
  if (condition === "empty" && found)
    throw new Error("Empty smoke state exposed Memory");
  if (condition === "relevant") {
    if (!found || !serialized.includes(request.task_name))
      throw new Error("Relevant smoke state lacked target-task Memory");
  }
  if (condition === "placebo") {
    if (!found || serialized.includes(request.task_name))
      throw new Error("Placebo smoke state did not remain task-disjoint");
  }
};

export const createDeterministicSmokeHarborExecutor =
  (): SubprocessExecutor => async (invocation) => {
    if (invocation.signal?.aborted)
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        terminationReason: "cancelled"
      };
    const requestPath = invocation.args.at(-1);
    if (!requestPath) throw new Error("Deterministic Harbor request is absent");
    const request = JSON.parse(
      await readFile(requestPath, "utf8")
    ) as HarborRunRequest;
    await lifecycle(invocation, request, "agent_started");
    let freezeManifestSha256: string | undefined;
    let replayTrajectorySha256: string | undefined;
    if (request.attempt_kind === "source") {
      const marker = `smoke evidence for ${request.task_name}`;
      const trajectory = `${JSON.stringify({
        schema_version: "ATIF-v1.7",
        session_id: `source-${request.task_name}`,
        agent: { name: "codex", version: "deterministic-smoke" },
        steps: [
          {
            step_id: 1,
            timestamp: "2026-08-12T00:00:00.000Z",
            source: "user",
            message: marker
          },
          {
            step_id: 2,
            timestamp: "2026-08-12T00:00:01.000Z",
            source: "agent",
            message: `Resolved ${marker}`
          }
        ]
      })}\n`;
      const trajectoryPath = path.join(
        request.run_root,
        request.freeze_trajectory_to
      );
      await mkdir(path.dirname(trajectoryPath), { recursive: true });
      await writeFile(trajectoryPath, trajectory, { flag: "wx", mode: 0o600 });
      const manifest = {
        schema_version: "koed-harbor-freeze-v1",
        adapter: {
          name: "harbor-codex",
          version: "0.21.0",
          commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
          raw_reasoning_capture_disabled: true
        },
        source_attempt: {
          trial_id: `smoke-source-${safeId(request.task_name)}`,
          task_name: request.task_name
        },
        lifecycle: [
          {
            ordinal: 1,
            event: "agent_started",
            timestamp: "2026-08-12T00:00:00.000Z"
          },
          {
            ordinal: 2,
            event: "agent_ended",
            timestamp: "2026-08-12T00:00:02.000Z"
          },
          {
            ordinal: 3,
            event: "trajectory_materialized",
            timestamp: "2026-08-12T00:00:03.000Z"
          },
          {
            ordinal: 4,
            event: "verification_started",
            timestamp: "2026-08-12T00:00:04.000Z"
          }
        ],
        cutoff: {
          agent_last_native_event_ordinal: null,
          step_identities: [1, 2].map((stepId) => ({
            step_id: stepId,
            identity_sha256: digest(`${stepId}:none`),
            last_native_event_ordinal: null
          }))
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
      await writeFile(manifestPath, manifestText, { flag: "wx", mode: 0o600 });
      freezeManifestSha256 = digest(manifestText);
    } else {
      const url = bridgeUrl(request);
      if (url) {
        const token = invocation.env.KOED_BENCHMARK_MCP_TOKEN;
        if (!token)
          throw new Error("Deterministic replay bridge token is absent");
        assertSmokeRecallBoundary(
          request,
          await callSmokeMemoryAnswer(url, token, request.task_name)
        );
      }
      const trajectory = `${JSON.stringify({
        schema_version: "ATIF-v1.7",
        session_id: `replay-${request.task_name}`,
        agent: { name: "codex", version: "deterministic-smoke" },
        steps: [
          {
            step_id: 1,
            timestamp: "2026-08-12T00:00:00.000Z",
            source: "user",
            message: `Complete ${request.task_name}`
          },
          {
            step_id: 2,
            timestamp: "2026-08-12T00:00:01.000Z",
            source: "agent",
            message: `Completed ${request.task_name}`
          }
        ]
      })}\n`;
      const trajectoryPath = path.join(
        request.run_root,
        request.replay_trajectory_path
      );
      await mkdir(path.dirname(trajectoryPath), { recursive: true });
      await writeFile(trajectoryPath, trajectory, { flag: "wx", mode: 0o600 });
      replayTrajectorySha256 = digest(trajectory);
      const manifest = {
        schema_version: "koed-harbor-freeze-v1",
        adapter: {
          name: "harbor-codex",
          version: "0.21.0",
          commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
          raw_reasoning_capture_disabled: true
        },
        source_attempt: {
          trial_id: `smoke-replay-${safeId(request.task_name)}`,
          task_name: request.task_name
        },
        lifecycle: [
          {
            ordinal: 1,
            event: "agent_started",
            timestamp: "2026-08-12T00:00:00.000Z"
          },
          {
            ordinal: 2,
            event: "agent_ended",
            timestamp: "2026-08-12T00:00:02.000Z"
          },
          {
            ordinal: 3,
            event: "trajectory_materialized",
            timestamp: "2026-08-12T00:00:03.000Z"
          },
          {
            ordinal: 4,
            event: "verification_started",
            timestamp: "2026-08-12T00:00:04.000Z"
          }
        ],
        cutoff: {
          agent_last_native_event_ordinal: null,
          step_identities: [1, 2].map((stepId) => ({
            step_id: stepId,
            identity_sha256: digest(`${stepId}:none`),
            last_native_event_ordinal: null
          }))
        },
        frozen_artifact: {
          relative_path: request.replay_trajectory_path,
          sha256: replayTrajectorySha256,
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
      await writeFile(manifestPath, manifestText, { flag: "wx", mode: 0o600 });
      freezeManifestSha256 = digest(manifestText);
    }
    await lifecycle(invocation, request, "agent_ended");
    await lifecycle(invocation, request, "trial_ended");
    const output = {
      schema_version: "koed-harbor-result-v1",
      runtime: {
        harbor_version: "0.21.0",
        harbor_commit: "64afbbcb62165950301e1a6407c729aa26d844ff",
        uv_lock_sha256: `sha256:${"2".repeat(64)}`,
        task_instruction_adaptation: {
          policy: "koed-memory-eval-task-instruction-v2",
          original_sha256: `sha256:${"4".repeat(64)}`,
          adapted_sha256: `sha256:${"5".repeat(64)}`,
          agent_guidance_sha256: `sha256:${"6".repeat(64)}`
        }
      },
      job_lock_sha256: `sha256:${"3".repeat(64)}`,
      ...(freezeManifestSha256
        ? { freeze_manifest_sha256: freezeManifestSha256 }
        : {}),
      ...(replayTrajectorySha256
        ? { replay_trajectory_sha256: replayTrajectorySha256 }
        : {}),
      result: {
        job_id: `smoke-${request.attempt_kind}-${safeId(request.task_name)}`,
        n_total_trials: 1,
        n_completed_trials: 1,
        n_errored_trials: 0,
        phase_timings: {
          setup_ms: 1,
          agent_ms: 1,
          verifier_ms: 1
        },
        interactions: {
          turns: request.attempt_kind === "source" ? 2 : 1,
          tool_calls: request.attempt_kind === "replay" ? 1 : 0
        },
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0
        },
        trials: [
          {
            trial_id: `smoke-${request.attempt_kind}-${safeId(request.task_name)}`,
            task_name: request.task_name,
            primary_reward: { field: "reward", value: 1, passed: true },
            errored: false,
            failure_category: null
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

export const createDeterministicSmokeProductRuntimeDependencies =
  (): Partial<ProductRuntimeDependencies> => ({
    startRuntime: (options) => {
      const serviceFactory: LocalAiRuntimeServiceFactory = () => {
        const executor: LocalAiRuntimeToolExecutor = {
          capabilities: () =>
            Promise.resolve({ curatedMemoryIntakeAvailable: false }),
          execute: async (name, input) => {
            if (name !== "memory_answer")
              throw new Error(`Unsupported deterministic smoke tool: ${name}`);
            const query = typeof input.query === "string" ? input.query : "";
            const apiUrl = options.environment?.MEMORY_API_URL;
            const apiToken = options.environment?.MEMORY_API_TOKEN;
            if (!apiUrl || !apiToken)
              throw new Error("Deterministic smoke API context is absent");
            const response = await fetch(`${apiUrl}/v1/memory/search`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiToken}`,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                query,
                retrieval_scope: "personal",
                search_domain: "global",
                limit: 10,
                strict_limit: true
              })
            });
            if (!response.ok)
              throw new Error(
                `Deterministic smoke Recall failed (${response.status})`
              );
            const result = (await response.json()) as { hits?: unknown[] };
            return {
              markdown: result.hits?.length
                ? "Relevant smoke evidence was found."
                : "No matching smoke evidence was found.",
              answer_status: result.hits?.length ? "found" : "not_found",
              relevant_memory_found: Boolean(result.hits?.length),
              evidence: result.hits ?? []
            };
          }
        };
        return Promise.resolve({
          executor,
          close: () => Promise.resolve()
        });
      };
      return startLocalAiRuntime({ ...options, serviceFactory });
    }
  });
