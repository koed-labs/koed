import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import {
  attestPinnedInputs,
  ProductPathPrerequisiteError
} from "./preflight.js";
import {
  createRecordedPreflightRuntime,
  immutableTaskImageMap
} from "./recorded-preflight-runtime.js";
import type { BoundedCommandExecutor } from "./toolchain.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const config = resolveExperienceReplayConfig({
  version: 1,
  profile: "quick",
  seed: "recorded-preflight-runtime",
  output_dir: "/tmp/recorded-preflight-runtime",
  codex_cli: {
    version: "codex 1.2.3",
    host_sha256: "a".repeat(64),
    container_sha256: "b".repeat(64),
    container_code_mode_host_sha256: "c".repeat(64)
  },
  coding_agent: { id: "gpt-5.6-luna", reasoning_effort: "low" },
  memory_answer: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  lcm_summary: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  session_title: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "v1",
    output_schema_version: "v1"
  },
  trajectory_judge: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "medium" },
    prompt_version: "experience-replay-trajectory-judge-v1",
    output_schema_version: "experience-replay-trajectory-judge-v1"
  },
  embedding: {
    model: "embedding",
    artifact_sha256: "c".repeat(64),
    tokenizer: "tokenizer",
    transform: "none-v1",
    dimensions: 8
  },
  price_table: {
    version: "v1",
    sha256: "d".repeat(64),
    models: {
      "gpt-5.6-luna": {
        uncached_input_usd_per_million: 1,
        cached_input_usd_per_million: 1,
        output_usd_per_million: 1
      }
    }
  },
  timeouts: {
    agent_seconds: 1,
    setup_seconds: 1,
    verifier_seconds: 1,
    preparation_seconds: 1,
    judge_seconds: 1,
    teardown_seconds: 1
  },
  admission: {
    maximum_trajectory_bytes: 1,
    estimated_attempt_artifact_bytes: 1,
    estimated_image_bytes_per_task: 1,
    scratch_multiplier: 1,
    minimum_free_space_reserve_bytes: 0,
    max_input_tokens_per_call: 1,
    max_output_tokens_per_call: 1,
    max_memory_answer_calls_per_attempt: 1,
    max_preparation_calls_per_source: 1,
    provider_spending_limit_usd: 10
  },
  paid_cost_stop_usd: 10
});

const environment = {
  PATH: "/usr/bin",
  OPENAI_API_KEY: "provider-secret",
  KOED_EXPERIENCE_REPLAY_HARBOR_UV_BINARY: "/tools/uv",
  KOED_EXPERIENCE_REPLAY_DOCKER_BINARY: "/tools/docker",
  KOED_EXPERIENCE_REPLAY_OCI_REGISTRY: "registry.example/koed",
  KOED_EXPERIENCE_REPLAY_HOST_CODEX_BINARY: "/tools/host-codex",
  KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY: "/tools/container-codex",
  KOED_EXPERIENCE_REPLAY_HOST_CODEX_HOME: "/auth/host",
  KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME: "/auth/container"
};

describe("recorded preflight runtime", () => {
  it("provisions selected images only through the locked Harbor runner and reinspects OCI identity", async () => {
    const executor = vi.fn<BoundedCommandExecutor>(async (command) => {
      if (command.file === "git") return { stdout: "", stderr: "" };
      if (command.file === "/tools/uv") {
        const taskName = command.args[command.args.indexOf("--task-name") + 1]!;
        const taskDigest =
          command.args[command.args.indexOf("--task-digest") + 1]!;
        return {
          stdout: JSON.stringify({
            schema_version: "koed-harbor-task-image-v1",
            task_name: taskName,
            task_digest: taskDigest,
            immutable_reference: `registry.example/koed/task@${digest("e")}`,
            image_id: digest("f"),
            content_digest: digest("e"),
            resolved_base_image_digests: [digest("1")],
            dockerfile_sha256: digest("2"),
            docker_version: "Docker 29.0.0",
            buildkit_version: "BuildKit 0.24.0",
            provenance_sha256: digest("3")
          }),
          stderr: ""
        };
      }
      if (command.file === "/tools/docker") {
        return {
          stdout: JSON.stringify({
            Id: digest("f"),
            RepoDigests: [`registry.example/koed/task@${digest("e")}`]
          }),
          stderr: ""
        };
      }
      throw new Error(`unexpected command ${command.file}`);
    });
    const runtime = createRecordedPreflightRuntime(config, environment, {
      executor
    });
    const pins = await attestPinnedInputs("quick");
    const images = await runtime.adapters.attestTaskImages(pins.selectedTasks);
    expect(images).toHaveLength(12);
    const uvCommands = executor.mock.calls
      .map(([command]) => command)
      .filter((command) => command.file === "/tools/uv");
    expect(uvCommands).toHaveLength(12);
    const firstUvCommand = uvCommands[0];
    expect(firstUvCommand?.args).toContain("run");
    expect(firstUvCommand?.args).toContain("--locked");
    expect(firstUvCommand?.args).toContain("runner.py");
    expect(firstUvCommand?.args).toContain("provision-task-image");
    expect(firstUvCommand?.env?.PATH).toBe(`/tools${path.delimiter}/usr/bin`);
  });

  it("requires explicit and distinct host/container auth contexts", () => {
    expect(() =>
      createRecordedPreflightRuntime(config, {
        ...environment,
        KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME: "/auth/host"
      })
    ).toThrow(ProductPathPrerequisiteError);
    expect(() =>
      createRecordedPreflightRuntime(config, {
        ...environment,
        KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_BINARY: "codex"
      })
    ).toThrow("must be an absolute path");
    expect(() =>
      createRecordedPreflightRuntime(config, {
        ...environment,
        KOED_EXPERIENCE_REPLAY_DOCKER_BINARY: "/tools/podman"
      })
    ).toThrow("must name the docker executable");
  });

  it("accepts a private subscription auth file without API credentials or duplicate homes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koed-preflight-auth-"));
    const authJsonPath = path.join(root, "auth.json");
    await writeFile(
      authJsonPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { access_token: "test-only" }
      }),
      { mode: 0o600 }
    );
    expect(() =>
      createRecordedPreflightRuntime(
        config,
        {
          ...environment,
          OPENAI_API_KEY: undefined,
          KOED_EXPERIENCE_REPLAY_HOST_CODEX_HOME: undefined,
          KOED_EXPERIENCE_REPLAY_CONTAINER_CODEX_HOME: undefined,
          KOED_EXPERIENCE_REPLAY_CODEX_AUTH_JSON_PATH: authJsonPath
        },
        {},
        "subscription"
      )
    ).not.toThrow();
  });

  it("exposes a frozen execution map without credential or mutable image data", () => {
    const map = immutableTaskImageMap({
      taskImages: [
        {
          taskName: "terminal-bench/task",
          taskDigest: digest("a"),
          immutableReference: `registry.example/task@${digest("b")}`,
          imageId: digest("c"),
          contentDigest: digest("b"),
          resolvedBaseImageDigests: [],
          dockerfileSha256: digest("d"),
          dockerVersion: "Docker 29",
          buildkitVersion: "BuildKit 0.24",
          provenanceSha256: null,
          attestationHash: "attestation"
        }
      ],
      hostCodex: { executable: {} as never, models: [] },
      containerCodex: { executable: {} as never, models: [] }
    });
    expect(map).toEqual({
      "terminal-bench/task": `registry.example/task@${digest("b")}`
    });
    expect(Object.isFrozen(map)).toBe(true);
  });
});
