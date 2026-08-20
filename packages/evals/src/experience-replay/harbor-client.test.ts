import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  HarborClient,
  HarborClientError,
  type HarborRunRequest,
  type SubprocessExecutor
} from "./harbor-client.js";

const result = JSON.stringify({
  schema_version: "koed-harbor-result-v1",
  runtime: {},
  job_lock_sha256: `sha256:${"a".repeat(64)}`,
  freeze_manifest_sha256: `sha256:${"b".repeat(64)}`,
  result: {}
});

const notifyLifecycle = async (
  environment: NodeJS.ProcessEnv,
  event: "agent_started" | "agent_ended" | "trial_ended",
  attemptKind: "source" | "replay" = "source"
): Promise<void> => {
  const socketPath = environment.KOED_HARBOR_LIFECYCLE_SOCKET;
  const token = environment.KOED_HARBOR_LIFECYCLE_TOKEN;
  if (!socketPath || !token) throw new Error("missing lifecycle environment");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let reply = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
    socket.once("end", () => {
      try {
        expect(JSON.parse(reply)).toEqual({
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
          attempt_kind: attemptKind,
          event,
          trial_id: "trial-cad",
          task_name: "terminal-bench/cad-model",
          timestamp: "2026-08-12T00:00:00.000Z"
        })}\n`
      );
    });
  });
};

const successfulExecution = async (
  invocation: Parameters<SubprocessExecutor>[0]
) => {
  await notifyLifecycle(invocation.env, "agent_started");
  await notifyLifecycle(invocation.env, "agent_ended");
  await notifyLifecycle(invocation.env, "trial_ended");
  return { exitCode: 0, signal: null, stdout: result, stderr: "" } as const;
};

const fixture = async (): Promise<{
  runRoot: string;
  request: HarborRunRequest;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-harbor-client-"));
  const runRoot = path.join(root, "run");
  await mkdir(runRoot);
  return {
    runRoot,
    request: {
      schema_version: "koed-harbor-run-v1",
      attempt_kind: "source",
      task_name: "terminal-bench/cad-model",
      task_image: `registry.example/cad-model@sha256:${"c".repeat(64)}`,
      codex_version: "0.147.0",
      codex_binary_sha256: `sha256:${"d".repeat(64)}`,
      codex_code_mode_host_sha256: `sha256:${"e".repeat(64)}`,
      job_config: { job_name: "source-cad-model", retry: { max_retries: 0 } },
      corpus_manifest: path.join(root, "tb3.json"),
      run_root: runRoot,
      freeze_manifest_path: "source/cad/freeze-manifest.json",
      freeze_trajectory_to: "source/cad/trajectory.json",
      result_path: "source/cad/result.json"
    }
  };
};

describe("HarborClient", () => {
  it("requires replay trajectory request and result fields exactly", async () => {
    const { request } = await fixture();
    const replayRequest = {
      ...request,
      attempt_kind: "replay" as const,
      replay_trajectory_path: "sensitive/replay.atif.json"
    } as Record<string, unknown>;
    delete replayRequest.freeze_trajectory_to;

    const missingManifest = { ...replayRequest };
    delete missingManifest.freeze_manifest_path;
    await expect(
      new HarborClient({ executor: vi.fn() }).run(
        missingManifest as unknown as HarborRunRequest
      )
    ).rejects.toMatchObject({ category: "invalid-request" });

    const missingPath = { ...replayRequest };
    delete missingPath.replay_trajectory_path;
    await expect(
      new HarborClient({ executor: vi.fn() }).run(
        missingPath as unknown as HarborRunRequest
      )
    ).rejects.toMatchObject({ category: "invalid-request" });

    const executor: SubprocessExecutor = async (invocation) => {
      await notifyLifecycle(invocation.env, "agent_started", "replay");
      await notifyLifecycle(invocation.env, "agent_ended", "replay");
      await notifyLifecycle(invocation.env, "trial_ended", "replay");
      return {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({
          schema_version: "koed-harbor-result-v1",
          runtime: {},
          job_lock_sha256: `sha256:${"a".repeat(64)}`,
          result: {}
        })}\n`,
        stderr: ""
      };
    };
    await expect(
      new HarborClient({ executor }).run(
        replayRequest as unknown as HarborRunRequest
      )
    ).rejects.toMatchObject({ category: "invalid-output" });
  });

  it("forbids replay trajectory fields on source requests and results", async () => {
    const { request } = await fixture();
    await expect(
      new HarborClient({ executor: vi.fn() }).run({
        ...request,
        replay_trajectory_path: "sensitive/replay.atif.json"
      } as HarborRunRequest)
    ).rejects.toMatchObject({ category: "invalid-request" });

    const client = new HarborClient({
      executor: async (invocation) => {
        const completed = await successfulExecution(invocation);
        return {
          ...completed,
          stdout: `${JSON.stringify({
            ...JSON.parse(result),
            replay_trajectory_sha256: `sha256:${"c".repeat(64)}`
          })}\n`
        };
      }
    });
    await expect(client.run(request)).rejects.toMatchObject({
      category: "invalid-output"
    });
  });

  it("invokes the locked runner without a shell and confines the request artifact", async () => {
    const { runRoot, request } = await fixture();
    let serialized = "";
    const executor = vi.fn<SubprocessExecutor>(async (invocation) => {
      expect(invocation.file).toBe("uv-test");
      expect(invocation.args.slice(0, 6)).toEqual([
        "run",
        "--locked",
        "--project",
        "/locked/harbor",
        "python",
        "runner.py"
      ]);
      expect(invocation.args.slice(6, 9)).toEqual([
        "run",
        "--request",
        expect.any(String)
      ]);
      const requestPath = invocation.args[8] as string;
      expect(path.relative(runRoot, requestPath)).toBe(
        path.join(".harbor-requests", "fixed-id.json")
      );
      serialized = await readFile(requestPath, "utf8");
      const completed = await successfulExecution(invocation);
      return { ...completed, stdout: `${result}\n` };
    });
    const client = new HarborClient({
      executor,
      uvExecutable: "uv-test",
      harborProject: "/locked/harbor",
      requestId: () => "fixed-id"
    });

    await expect(client.run(request)).resolves.toMatchObject({
      schema_version: "koed-harbor-result-v1"
    });
    expect(JSON.parse(serialized)).toEqual(request);
    await expect(
      readFile(path.join(runRoot, ".harbor-requests/fixed-id.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps secrets out of argv and serialized requests", async () => {
    const { request } = await fixture();
    const executor = vi.fn<SubprocessExecutor>();
    const client = new HarborClient({
      executor,
      requestId: () => "secret-test"
    });
    request.job_config = {
      ...request.job_config,
      agents: [
        { name: "codex", env: { OPENAI_API_KEY: "sk-supersecret123456" } }
      ]
    };

    await expect(client.run(request)).rejects.toMatchObject({
      category: "invalid-request"
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("retains a validated local request when the runner fails", async () => {
    const { runRoot, request } = await fixture();
    const client = new HarborClient({
      executor: async () => ({
        exitCode: 2,
        signal: null,
        stdout: "",
        stderr:
          "harmless Harbor warning\nexperience-replay Harbor contract error (OUTPUT_ALREADY_EXISTS)\n"
      }),
      uvExecutable: "uv-test",
      harborProject: "/locked/harbor",
      requestId: () => "failed-id"
    });

    const failure = await client.run(request).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(HarborClientError);
    if (!(failure instanceof HarborClientError)) {
      throw new Error("Expected HarborClientError");
    }
    expect(failure.category).toBe("process-exit");
    expect(failure.contractCode).toBe("OUTPUT_ALREADY_EXISTS");
    expect(failure.message).toContain("OUTPUT_ALREADY_EXISTS");
    const retained = await readFile(
      path.join(runRoot, ".harbor-requests/failed-id.json"),
      "utf8"
    );
    const retainedRequest = JSON.parse(retained) as unknown;
    expect(retainedRequest).toEqual(request);
  });

  it("allows literal environment references without serializing values", async () => {
    const { request } = await fixture();
    const executor = vi.fn<SubprocessExecutor>(successfulExecution);
    request.job_config = {
      ...request.job_config,
      agents: [
        {
          name: "codex",
          env: {
            OPENAI_API_KEY: "${OPENAI_API_KEY}",
            KOED_BENCHMARK_MCP_TOKEN: "${KOED_BENCHMARK_MCP_TOKEN}"
          }
        }
      ]
    };
    await expect(
      new HarborClient({ executor }).run(request)
    ).resolves.toMatchObject({ schema_version: "koed-harbor-result-v1" });
  });

  it("allows a credential environment-variable name but rejects a credential value", async () => {
    const { request } = await fixture();
    const executor = vi.fn<SubprocessExecutor>(successfulExecution);
    request.job_config = {
      agents: [
        {
          name: "codex",
          kwargs: {
            config: {
              mcp_servers: {
                koed: {
                  bearer_token_env_var: "KOED_BENCHMARK_MCP_TOKEN"
                }
              }
            }
          }
        }
      ]
    };
    await expect(
      new HarborClient({ executor }).run(request)
    ).resolves.toMatchObject({ schema_version: "koed-harbor-result-v1" });
    (
      request.job_config.agents as Array<{
        kwargs: { config: { mcp_servers: { koed: Record<string, string> } } };
      }>
    )[0]!.kwargs.config.mcp_servers.koed.bearer_token_env_var =
      "sk-secret-value-123456";
    await expect(
      new HarborClient({ executor }).run(request)
    ).rejects.toMatchObject({ category: "invalid-request" });
  });

  it.each([
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["output-limit", "output-limit"]
  ] as const)("categorizes %s termination", async (reason, category) => {
    const { request } = await fixture();
    const client = new HarborClient({
      executor: async () => ({
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        terminationReason: reason
      })
    });
    await expect(client.run(request)).rejects.toMatchObject({ category });
  });

  it("passes cancellation and bounded-output controls to the executor", async () => {
    const { request } = await fixture();
    const controller = new AbortController();
    const executor = vi.fn<SubprocessExecutor>(async (invocation) => {
      expect(invocation.signal).toBe(controller.signal);
      expect(invocation.timeoutMs).toBe(1234);
      expect(invocation.maxStdoutBytes).toBe(1000);
      expect(invocation.maxStderrBytes).toBe(50);
      return successfulExecution(invocation);
    });
    await new HarborClient({
      executor,
      timeoutMs: 1234,
      maxStdoutBytes: 1000,
      maxStderrBytes: 50
    }).run(request, controller.signal);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("inherits only the minimal host environment and explicit trial values", async () => {
    const { request } = await fixture();
    const previous = process.env.UNRELATED_OPERATOR_SECRET;
    process.env.UNRELATED_OPERATOR_SECRET = "must-not-cross-the-boundary";
    try {
      const executor = vi.fn<SubprocessExecutor>(async (invocation) => {
        expect(invocation.env.UNRELATED_OPERATOR_SECRET).toBeUndefined();
        expect(invocation.env.KOED_BENCHMARK_MCP_TOKEN).toBe("trial-secret");
        expect(invocation.env.PATH).toBe(process.env.PATH);
        return successfulExecution(invocation);
      });
      await new HarborClient({
        executor,
        environment: { KOED_BENCHMARK_MCP_TOKEN: "trial-secret" }
      }).run(request);
    } finally {
      if (previous === undefined) delete process.env.UNRELATED_OPERATOR_SECRET;
      else process.env.UNRELATED_OPERATOR_SECRET = previous;
    }
  });

  it("enforces output bounds even when an injected executor does not", async () => {
    const { request } = await fixture();
    const client = new HarborClient({
      maxStdoutBytes: 10,
      executor: async () => ({
        exitCode: 0,
        signal: null,
        stdout: result,
        stderr: ""
      })
    });
    await expect(client.run(request)).rejects.toMatchObject({
      category: "output-limit"
    });
  });

  it("recovers a completed result from its persisted artifact", async () => {
    const { runRoot, request } = await fixture();
    const client = new HarborClient({
      executor: async (invocation) => {
        await notifyLifecycle(invocation.env, "agent_started");
        await notifyLifecycle(invocation.env, "agent_ended");
        await notifyLifecycle(invocation.env, "trial_ended");
        const resultPath = path.join(runRoot, request.result_path!);
        await mkdir(path.dirname(resultPath), { recursive: true });
        await writeFile(resultPath, `${result}\n`);
        return {
          exitCode: 0,
          signal: null,
          stdout: `Harbor diagnostic\n${result}\n`,
          stderr: ""
        };
      }
    });

    await expect(client.run(request)).resolves.toMatchObject({
      schema_version: "koed-harbor-result-v1"
    });
  });

  it.each([
    [
      "process-exit",
      { exitCode: 2, signal: null, stdout: "", stderr: "contract error" }
    ],
    [
      "invalid-output",
      {
        exitCode: 0,
        signal: null,
        stdout: `${result}\n${result}\n`,
        stderr: ""
      }
    ]
  ] as const)(
    "categorizes %s failures without exposing stderr",
    async (category, execution) => {
      const { request } = await fixture();
      const client = new HarborClient({
        executor: async (invocation) => {
          if (execution.exitCode === 0) {
            await notifyLifecycle(invocation.env, "agent_started");
            await notifyLifecycle(invocation.env, "agent_ended");
            await notifyLifecycle(invocation.env, "trial_ended");
          }
          return execution;
        }
      });
      let thrown: unknown;
      try {
        await client.run(request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HarborClientError);
      expect(thrown).toMatchObject({ category });
      expect(String(thrown)).not.toContain("contract error");
    }
  );
});
