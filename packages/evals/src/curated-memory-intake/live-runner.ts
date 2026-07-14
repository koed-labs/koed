import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDbPool } from "@koed/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  resolveCuratedMemoryReviewConfig,
  reviewCuratedMemoryProposal,
  type CuratedMemoryReviewBundle
} from "@koed/mcp-server";
import { curatedMemoryIntakeCases } from "./cases.js";
import {
  scoreCuratedMemoryIntakeRun,
  summarizeCuratedMemoryIntakeBenchmark,
  type CuratedMemoryIntakeCase,
  type CuratedMemoryIntakeResult,
  type CuratedMemoryRecallHit,
  type CuratedMemoryIntakeRunInput,
  type CuratedMemoryIntakeToolCall
} from "./benchmark.js";
import {
  judgeAcceptedCuratedMemory,
  type CuratedMemorySemanticJudgeConfig
} from "./semantic-judge.js";

type RunnerMode =
  | "deterministic-workflow"
  | "reviewer-adversarial"
  | "live-ai-client";

interface RunnerOptions {
  databaseUrl: string;
  mode: RunnerMode;
  caseIds: string[];
  runs?: number;
  model: string;
  judgeModel: string;
  judgeReasoningEffort: string;
  codexBinary: string;
  outputPath?: string;
  keepDatabase: boolean;
  keepTemp: boolean;
}

interface TemporaryDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

type BuildServer = () => Promise<FastifyInstance>;

const loadBuildServer = async (): Promise<BuildServer> => {
  const apiPackageName = "@koed/api";
  const apiModule: unknown = await import(apiPackageName);
  if (
    !apiModule ||
    typeof apiModule !== "object" ||
    !("buildServer" in apiModule) ||
    typeof apiModule.buildServer !== "function"
  ) {
    throw new Error("@koed/api does not export buildServer");
  }
  return apiModule.buildServer as BuildServer;
};

const args = process.argv.slice(2);
const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const parseOptions = (): RunnerOptions => {
  const databaseUrl =
    optionValue("--database-url") ??
    process.env.CURATED_MEMORY_INTAKE_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "A PostgreSQL URL is required through --database-url, CURATED_MEMORY_INTAKE_DATABASE_URL, or DATABASE_URL."
    );
  }
  const mode = optionValue("--mode") ?? "deterministic-workflow";
  if (
    mode !== "deterministic-workflow" &&
    mode !== "reviewer-adversarial" &&
    mode !== "live-ai-client"
  ) {
    throw new Error(
      "--mode must be deterministic-workflow, reviewer-adversarial, or live-ai-client"
    );
  }
  const runsValue = optionValue("--runs");
  const runs = runsValue ? Number.parseInt(runsValue, 10) : undefined;
  if (runs !== undefined && (!Number.isFinite(runs) || runs < 1)) {
    throw new Error("--runs must be a positive integer");
  }
  return {
    databaseUrl,
    mode,
    caseIds:
      optionValue("--case")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? [],
    ...(runs === undefined ? {} : { runs }),
    model:
      optionValue("--model") ??
      process.env.MEMORY_CURATED_INTAKE_MODEL ??
      "gpt-5.4-mini",
    judgeModel:
      optionValue("--judge-model") ??
      process.env.MEMORY_CURATED_INTAKE_JUDGE_MODEL ??
      "gpt-5.4-mini",
    judgeReasoningEffort:
      optionValue("--judge-reasoning-effort") ??
      process.env.MEMORY_CURATED_INTAKE_JUDGE_REASONING_EFFORT ??
      "medium",
    codexBinary:
      optionValue("--codex") ??
      process.env.MEMORY_CODEX_APP_SERVER_BINARY ??
      "codex",
    ...(optionValue("--out") ? { outputPath: optionValue("--out") } : {}),
    keepDatabase: args.includes("--keep-database"),
    keepTemp: args.includes("--keep-temp")
  };
};

const quoteIdent = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const databaseUrlWithName = (baseUrl: string, name: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const maintenanceDatabaseUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  return url.toString();
};

const createTemporaryDatabase = async (
  baseUrl: string,
  keep: boolean
): Promise<TemporaryDatabase> => {
  const name = `koed_curated_eval_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const maintenance = createDbPool({
    connectionString: maintenanceDatabaseUrl(baseUrl)
  });
  await maintenance.query(`create database ${quoteIdent(name)}`);
  await maintenance.end();
  return {
    name,
    url: databaseUrlWithName(baseUrl, name),
    async drop() {
      if (keep) {
        return;
      }
      const pool = createDbPool({
        connectionString: maintenanceDatabaseUrl(baseUrl)
      });
      try {
        await pool.query(
          `drop database if exists ${quoteIdent(name)} with (force)`
        );
      } finally {
        await pool.end();
      }
    }
  };
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");
const fakeIntakeMcpPath = path.join(currentDirectory, "fake-intake-mcp.js");
const sourceCodexHome =
  process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

const copyCodexAuth = async (targetHome: string): Promise<void> => {
  for (const filename of ["auth.json", ".credentials.json"]) {
    const source = path.join(sourceCodexHome, filename);
    if (fs.existsSync(source)) {
      await copyFile(source, path.join(targetHome, filename));
    }
  }
};

const runCommand = (
  command: string,
  commandArgs: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });

const liveAiClientCalls = async (
  benchmarkCase: CuratedMemoryIntakeCase,
  runIndex: number,
  options: RunnerOptions
): Promise<CuratedMemoryIntakeToolCall[]> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "koed-curated-intake-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  const logPath = path.join(root, "tool-calls.jsonl");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  await copyCodexAuth(codexHome);
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model = ${JSON.stringify(options.model)}`,
      `approval_policy = "never"`,
      "",
      "[mcp_servers.koed_curated_intake_eval]",
      `command = "node"`,
      `args = [${JSON.stringify(fakeIntakeMcpPath)}]`,
      "enabled = true",
      "required = true",
      `default_tools_approval_mode = "approve"`,
      "",
      "[mcp_servers.koed_curated_intake_eval.env]",
      `CURATED_MEMORY_INTAKE_LOG_PATH = ${JSON.stringify(logPath)}`
    ].join("\n")
  );
  const prompt =
    benchmarkCase.sourceActor === "agent"
      ? `The following text is an assistant-authored statement, not a user-provided fact:\n\n${benchmarkCase.prompt}`
      : benchmarkCase.prompt;
  try {
    const result = await runCommand(
      options.codexBinary,
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        workspace,
        "--model",
        options.model,
        prompt
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          CODEX_HOME: codexHome
        },
        timeoutMs: 180_000
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Codex exited ${result.exitCode} for ${benchmarkCase.id}/${runIndex}\n${result.stderr}`
      );
    }
    if (!fs.existsSync(logPath)) {
      return [];
    }
    return (await readFile(logPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as CuratedMemoryIntakeToolCall;
        return { toolName: parsed.toolName, arguments: parsed.arguments };
      });
  } finally {
    if (options.keepTemp) {
      console.error(`Kept live AI Client fixture: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
};

const deterministicCalls = (
  benchmarkCase: CuratedMemoryIntakeCase,
  forceProposal = false
): CuratedMemoryIntakeToolCall[] =>
  benchmarkCase.expected.shouldPropose || forceProposal
    ? [
        {
          toolName: "memory_intake_propose",
          arguments: {
            proposed_claim: benchmarkCase.prompt,
            proposed_topic:
              benchmarkCase.expected.proposalTopic ?? "Durable memory",
            tags: benchmarkCase.expected.tags ?? [],
            sensitivity_hint: benchmarkCase.expected.sensitivity ?? "normal",
            evidence_exact_quote: benchmarkCase.prompt
          }
        }
      ]
    : [];

const injectJson = async (
  app: FastifyInstance,
  input: InjectOptions
): Promise<JsonResponse> => {
  const response = await app.inject(input);
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>
  };
};

const tokenForNewUser = async (
  app: FastifyInstance,
  caseId: string,
  runIndex: number
): Promise<string> => {
  const registered = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: `${caseId}-${runIndex}-${randomUUID()}@eval.koed.local`,
      password: "curated-memory-eval-password"
    }
  });
  if (registered.statusCode !== 200) {
    throw new Error(`Registration failed: ${registered.body}`);
  }
  const cookie = registered.headers["set-cookie"];
  const sessionCookie = Array.isArray(cookie) ? cookie[0] : cookie;
  if (!sessionCookie) {
    throw new Error("Registration did not return a session cookie");
  }
  const created = await injectJson(app, {
    method: "POST",
    url: "/api-tokens",
    headers: { cookie: sessionCookie },
    payload: { name: "Curated Memory workflow eval" }
  });
  if (created.statusCode !== 200 || typeof created.body.token !== "string") {
    throw new Error(
      `API Token creation failed: ${JSON.stringify(created.body)}`
    );
  }
  return created.body.token;
};

const runWorkflowCase = async (
  app: FastifyInstance,
  benchmarkCase: CuratedMemoryIntakeCase,
  runIndex: number,
  calls: CuratedMemoryIntakeToolCall[],
  semanticJudgeConfig: CuratedMemorySemanticJudgeConfig
): Promise<CuratedMemoryIntakeRunInput> => {
  const token = await tokenForNewUser(app, benchmarkCase.id, runIndex);
  const authorization = `Bearer ${token}`;
  const workspaceId = `eval://${benchmarkCase.id}/${runIndex}`;
  const captured = await injectJson(app, {
    method: "POST",
    url: "/v1/memory/capture-personal-event",
    headers: { authorization },
    payload: {
      workspaceId,
      actor: benchmarkCase.sourceActor ?? "user",
      eventType: "curated_memory_eval_prompt",
      content: benchmarkCase.prompt,
      metadata: { benchmarkCaseId: benchmarkCase.id, runIndex },
      sourceRuntime: "codex",
      captureMethod: "api",
      idempotencyKey: `curated-eval:${benchmarkCase.id}:${runIndex}:${randomUUID()}`
    }
  });
  if (captured.statusCode !== 200) {
    throw new Error(
      `Evidence capture failed: ${JSON.stringify(captured.body)}`
    );
  }

  const intakeCall = calls.find(
    (call) => call.toolName === "memory_intake_propose"
  );
  const scoredCalls = calls.map((call) => ({
    ...call,
    arguments: { ...call.arguments, source_workspace_id: workspaceId }
  }));
  let intake: CuratedMemoryIntakeRunInput["intake"] = {
    proposalStatus: "skipped"
  };
  if (intakeCall) {
    const args = intakeCall.arguments;
    const proposed = await injectJson(app, {
      method: "POST",
      url: "/v1/memory/curated/proposals",
      headers: { authorization },
      payload: {
        proposed_claim: args.proposed_claim,
        proposed_topic: args.proposed_topic,
        rationale: args.rationale,
        tags: Array.isArray(args.tags) ? args.tags : [],
        sensitivity_hint: args.sensitivity_hint ?? "normal",
        expires_at: args.expires_at,
        evidence_conversation_item_ids: [],
        evidence_memory_event_ids: [],
        evidence_exact_quote: args.evidence_exact_quote,
        source_workspace_id: workspaceId,
        created_by_model: "curated-memory-live-eval",
        created_by_prompt_version: "curated-memory-live-eval-v1"
      }
    });
    const proposal = proposed.body.proposal as
      | Record<string, unknown>
      | undefined;
    if (proposed.statusCode === 200 && typeof proposal?.id === "string") {
      const claimed = await injectJson(app, {
        method: "POST",
        url: "/v1/memory/curated/proposals/claim-pending",
        headers: { authorization },
        payload: { proposal_id: proposal.id, limit: 1, lease_seconds: 240 }
      });
      const reviewBundle = Array.isArray(claimed.body.reviews)
        ? (claimed.body.reviews[0] as CuratedMemoryReviewBundle | undefined)
        : undefined;
      if (claimed.statusCode !== 200 || !reviewBundle) {
        throw new Error(`Review claim failed: ${JSON.stringify(claimed.body)}`);
      }
      const review = await reviewCuratedMemoryProposal(
        reviewBundle,
        resolveCuratedMemoryReviewConfig(process.env, {
          model: options.model,
          appServerBinary: options.codexBinary,
          cwd: repositoryRoot,
          timeoutMs: 180_000
        })
      );
      const evidenceRevisions = reviewBundle.evidence.map((evidence) => ({
        source_type: evidence.sourceType,
        source_id: evidence.sourceId,
        source_hash: evidence.sourceHash
      }));
      const candidateAssertionIds = reviewBundle.currentAssertions.map(
        (assertion) => assertion.assertionId
      );
      const submitted = await injectJson(app, {
        method: "PATCH",
        url: `/v1/memory/curated/proposals/${proposal.id}/review`,
        headers: { authorization },
        payload: {
          outcome: review.decision.outcome,
          attempt_count: reviewBundle.proposal.attemptCount,
          evidence_revisions: evidenceRevisions,
          selected_evidence_ids:
            review.decision.outcome === "accepted"
              ? review.decision.selected_evidence_ids
              : [],
          candidate_assertion_ids: candidateAssertionIds,
          decision_reason: review.decision.decision_reason,
          worker_result: {
            reviewer: "local_codex_app_server",
            promptTokens: review.promptTokens,
            inputTokens: review.inputTokens,
            outputTokens: review.outputTokens,
            latencyMs: review.latencyMs,
            reasonCategory: review.decision.reason_category
          },
          ...(review.decision.outcome === "accepted"
            ? {
                operation: review.decision.operation,
                target_assertion_id: review.decision.target_assertion_id,
                assertion_text: review.decision.assertion_text,
                topic_title: review.decision.topic_title,
                tags: review.decision.tags,
                sensitivity: review.decision.sensitivity,
                confidence: review.decision.confidence,
                expires_at: review.decision.expires_at,
                reviewer_model: review.model,
                reviewer_prompt_version: "curated-memory-local-review-v1"
              }
            : {})
        }
      });
      if (submitted.statusCode !== 200) {
        throw new Error(
          `Review completion failed: ${JSON.stringify(submitted.body)}`
        );
      }
      const completed = submitted.body.proposal as Record<string, unknown>;
      intake = {
        proposalId: proposal.id,
        proposalStatus:
          completed.status as CuratedMemoryIntakeResult["proposalStatus"],
        assertionId:
          typeof completed.assertionId === "string"
            ? completed.assertionId
            : null,
        assertionText:
          review.decision.outcome === "accepted"
            ? review.decision.assertion_text
            : null,
        skippedReason:
          typeof completed.decisionReason === "string"
            ? completed.decisionReason
            : null,
        review: {
          outcome: review.decision.outcome,
          reasonCategory: review.decision.reason_category,
          promptTokens: review.promptTokens,
          inputTokens: review.inputTokens,
          outputTokens: review.outputTokens,
          latencyMs: review.latencyMs
        }
      };
    } else {
      intake = {
        skippedReason: JSON.stringify(proposed.body)
      };
    }
  }

  const query =
    benchmarkCase.expected.recallQuery ??
    benchmarkCase.expected.referenceClaim ??
    benchmarkCase.prompt;
  const recalled = await injectJson(app, {
    method: "POST",
    url: "/v1/memory/search",
    headers: { authorization },
    payload: {
      query,
      retrieval_scope: "personal",
      search_domain: "global",
      retrieval_stage: "curated_memory_search",
      limit: 10
    }
  });
  if (recalled.statusCode !== 200) {
    throw new Error(`Recall failed: ${JSON.stringify(recalled.body)}`);
  }
  const run: CuratedMemoryIntakeRunInput = {
    caseId: benchmarkCase.id,
    runIndex,
    calls: scoredCalls,
    intake,
    recall: {
      hits: Array.isArray(recalled.body.hits)
        ? (recalled.body.hits as CuratedMemoryRecallHit[])
        : []
    }
  };
  if (
    benchmarkCase.expected.shouldPropose &&
    intakeCall &&
    intake?.assertionId &&
    intake.assertionText
  ) {
    run.semanticAssessment = await judgeAcceptedCuratedMemory(
      {
        benchmarkCase,
        proposal: intakeCall,
        intake
      },
      {
        config: semanticJudgeConfig
      }
    );
  }
  return run;
};

const withEnvironment = async <T>(
  environment: Record<string, string>,
  run: () => Promise<T>
): Promise<T> => {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environment)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const options = parseOptions();
const selected =
  options.caseIds.length === 0
    ? curatedMemoryIntakeCases
    : curatedMemoryIntakeCases.filter((benchmarkCase) =>
        options.caseIds.includes(benchmarkCase.id)
      );
if (selected.length === 0) {
  throw new Error("No Curated Memory intake cases selected");
}

const database = await createTemporaryDatabase(
  options.databaseUrl,
  options.keepDatabase
);
const encryptionKey = randomBytes(32).toString("base64");
const environment = {
  DATABASE_URL: database.url,
  WORK_QUEUE_BACKEND: "local",
  KOED_DEPLOYMENT_PROFILE: "private_vps",
  KOED_ALLOW_PUBLIC_REGISTRATION: "true",
  API_DATA_ENCRYPTION_KEY: encryptionKey,
  API_TOKEN_PEPPER: randomBytes(32).toString("hex"),
  EMBEDDING_MODEL: "qwen3-0.6b",
  EMBEDDING_SERVICE_URL: "http://127.0.0.1:1",
  MEMORY_RAW_PROJECTION_INTERVAL_MS: "60000",
  AUTH_RATE_LIMIT_MAX: "100000",
  MEMORY_READ_RATE_LIMIT_MAX: "100000",
  MEMORY_WRITE_RATE_LIMIT_MAX: "100000",
  MEMORY_RECALL_RATE_LIMIT_MAX: "100000",
  NODE_ENV: "development"
};

try {
  const report = await withEnvironment(environment, async () => {
    const buildServer = await loadBuildServer();
    const app = await buildServer();
    const semanticJudgeConfig: CuratedMemorySemanticJudgeConfig = {
      appServerBinary: options.codexBinary,
      model: options.judgeModel,
      reasoningEffort: options.judgeReasoningEffort,
      timeoutMs: 180_000,
      maxAttempts: 2,
      retryDelayMs: 1_000,
      cwd: repositoryRoot,
      env: process.env
    };
    const runInputs: CuratedMemoryIntakeRunInput[] = [];
    try {
      for (const benchmarkCase of selected) {
        const runCount = options.runs ?? 1;
        for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
          console.error(
            `Running ${options.mode} ${benchmarkCase.id} ${runIndex + 1}/${runCount}`
          );
          const calls =
            options.mode === "live-ai-client"
              ? await liveAiClientCalls(benchmarkCase, runIndex, options)
              : deterministicCalls(
                  benchmarkCase,
                  options.mode === "reviewer-adversarial"
                );
          runInputs.push(
            await runWorkflowCase(
              app,
              benchmarkCase,
              runIndex,
              calls,
              semanticJudgeConfig
            )
          );
        }
      }
    } finally {
      await app.close();
    }
    const byId = new Map(
      curatedMemoryIntakeCases.map((benchmarkCase) => [
        benchmarkCase.id,
        benchmarkCase
      ])
    );
    const summary = summarizeCuratedMemoryIntakeBenchmark(
      runInputs.map((run) =>
        scoreCuratedMemoryIntakeRun(byId.get(run.caseId)!, run)
      )
    );
    return {
      suite: "curated-memory-intake-workflow",
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      proposerModel: options.mode === "live-ai-client" ? options.model : null,
      reviewerModel: options.model,
      semanticJudgeModel: options.judgeModel,
      semanticJudgeReasoningEffort: options.judgeReasoningEffort,
      database: {
        isolation: "temporary_database",
        name: database.name,
        kept: options.keepDatabase
      },
      cases: selected.map((benchmarkCase) => benchmarkCase.id),
      runInputs,
      summary
    };
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    await writeFile(options.outputPath, serialized);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  await database.drop();
}
