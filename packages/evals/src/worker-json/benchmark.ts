import { z } from "zod";

const memoryStatusSchema = z.enum([
  "found",
  "not_found",
  "insufficient",
  "pending_summary"
]);

const memoryAnswerSchema = z
  .object({
    schema_version: z.literal("memory-answer-v1"),
    memory_status: memoryStatusSchema,
    relevant_memory_found: z.boolean(),
    answer_markdown: z.string(),
    relevance_explanation: z.string(),
    evidence: z.array(z.unknown()).default([]),
    missing: z.array(z.string()).default([]),
    missing_evidence: z.array(z.string()).default([])
  })
  .passthrough();

const lcmSummarySchema = z
  .object({
    schema_version: z.literal("lcm-structured-summary-v1"),
    summary_text: z.string(),
    user_requests: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
    facts: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
    model_names: z.array(z.string()).default([]),
    tool_outcomes: z.array(z.string()).default([]),
    errors: z.array(z.string()).default([]),
    unresolved_questions: z.array(z.string()).default([]),
    provenance_hints: z.array(z.string()).default([])
  })
  .passthrough();

export type WorkerKind = "memory_answer" | "lcm_summary";

export interface WorkerJsonCase {
  id: string;
  worker: WorkerKind;
  prompt: string;
  expected: {
    status?: z.infer<typeof memoryStatusSchema>;
    relevantMemoryFound?: boolean;
    requiredSubstrings?: string[];
    minEvidenceItems?: number;
    requiredArrayKeys?: string[];
    minNonEmptyStructuredArrays?: number;
  };
  notes?: string;
}

export interface WorkerJsonRunInput {
  caseId: string;
  runIndex: number;
  worker: WorkerKind;
  output: unknown;
}

export interface WorkerJsonScoreDetail {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
  actual?: unknown;
}

export interface WorkerJsonRunScore {
  caseId: string;
  runIndex: number;
  worker: WorkerKind;
  score: number;
  maxScore: number;
  validJson: boolean;
  details: WorkerJsonScoreDetail[];
}

export interface WorkerJsonBenchmarkSummary {
  runs: WorkerJsonRunScore[];
  totalScore: number;
  maxScore: number;
  averageScoreRatio: number;
  validJsonRate: number;
}

const parseOutput = (output: unknown): unknown => {
  if (typeof output !== "string") {
    return output;
  }
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenced ? (fenced[1] ?? "").trim() : trimmed;
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  const json =
    firstBrace >= 0 && lastBrace > firstBrace
      ? unfenced.slice(firstBrace, lastBrace + 1)
      : unfenced;
  return JSON.parse(json) as unknown;
};

const scoreSubstring = (
  haystack: string,
  substring: string
): WorkerJsonScoreDetail => {
  const ok = haystack.toLowerCase().includes(substring.toLowerCase());
  return {
    name: `contains:${substring}`,
    score: ok ? 2 : 0,
    maxScore: 2,
    reason: ok ? "present" : "missing"
  };
};

const structuredArrays = (record: Record<string, unknown>): string[] =>
  Object.entries(record)
    .filter(
      ([, value]) =>
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && item.trim())
    )
    .map(([key]) => key);

export const scoreWorkerJsonRun = (
  benchmarkCase: WorkerJsonCase,
  run: WorkerJsonRunInput
): WorkerJsonRunScore => {
  const details: WorkerJsonScoreDetail[] = [];
  let parsed: unknown;
  try {
    parsed = parseOutput(run.output);
  } catch (error) {
    return {
      caseId: run.caseId,
      runIndex: run.runIndex,
      worker: run.worker,
      score: 0,
      maxScore: 1,
      validJson: false,
      details: [
        {
          name: "json",
          score: 0,
          maxScore: 1,
          reason: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }

  if (benchmarkCase.worker === "memory_answer") {
    const parsedAnswer = memoryAnswerSchema.safeParse(parsed);
    if (!parsedAnswer.success) {
      return {
        caseId: run.caseId,
        runIndex: run.runIndex,
        worker: run.worker,
        score: 0,
        maxScore: 1,
        validJson: false,
        details: [
          {
            name: "schema",
            score: 0,
            maxScore: 1,
            reason: parsedAnswer.error.message
          }
        ]
      };
    }
    const answer = parsedAnswer.data;
    details.push({
      name: "schema",
      score: 3,
      maxScore: 3,
      reason: "valid memory_answer JSON"
    });
    if (benchmarkCase.expected.status) {
      const ok = answer.memory_status === benchmarkCase.expected.status;
      details.push({
        name: "memory_status",
        score: ok ? 3 : 0,
        maxScore: 3,
        reason: ok ? "expected" : "unexpected",
        actual: answer.memory_status
      });

      const expectedRelevant =
        benchmarkCase.expected.relevantMemoryFound ??
        answer.memory_status === "found";
      details.push({
        name: "relevant_memory_found",
        score: answer.relevant_memory_found === expectedRelevant ? 2 : 0,
        maxScore: 2,
        reason:
          answer.relevant_memory_found === expectedRelevant
            ? "consistent with memory_status"
            : "inconsistent with memory_status",
        actual: answer.relevant_memory_found
      });
    }

    details.push({
      name: "relevance_explanation",
      score: answer.relevance_explanation.trim().length > 0 ? 1 : 0,
      maxScore: 1,
      reason:
        answer.relevance_explanation.trim().length > 0 ? "present" : "missing"
    });
    const minEvidence = benchmarkCase.expected.minEvidenceItems;
    if (minEvidence !== undefined) {
      const ok = answer.evidence.length >= minEvidence;
      details.push({
        name: "evidence_count",
        score: ok ? 2 : 0,
        maxScore: 2,
        reason: ok
          ? "enough evidence metadata"
          : "too little evidence metadata",
        actual: answer.evidence.length
      });
    }
    for (const substring of benchmarkCase.expected.requiredSubstrings ?? []) {
      details.push(scoreSubstring(answer.answer_markdown, substring));
    }
  } else {
    const parsedSummary = lcmSummarySchema.safeParse(parsed);
    if (!parsedSummary.success) {
      return {
        caseId: run.caseId,
        runIndex: run.runIndex,
        worker: run.worker,
        score: 0,
        maxScore: 1,
        validJson: false,
        details: [
          {
            name: "schema",
            score: 0,
            maxScore: 1,
            reason: parsedSummary.error.message
          }
        ]
      };
    }
    const summary = parsedSummary.data;
    details.push({
      name: "schema",
      score: 3,
      maxScore: 3,
      reason: "valid lcm_summary JSON"
    });
    for (const substring of benchmarkCase.expected.requiredSubstrings ?? []) {
      details.push(scoreSubstring(summary.summary_text, substring));
    }
    for (const key of benchmarkCase.expected.requiredArrayKeys ?? []) {
      const value = summary[key as keyof typeof summary];
      const ok =
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && item.trim());
      details.push({
        name: `array:${key}`,
        score: ok ? 2 : 0,
        maxScore: 2,
        reason: ok ? "non-empty" : "missing or empty",
        actual: value
      });
    }
    const minArrays = benchmarkCase.expected.minNonEmptyStructuredArrays;
    if (minArrays !== undefined) {
      const arrays = structuredArrays(summary);
      const ok = arrays.length >= minArrays;
      details.push({
        name: "structured_array_count",
        score: ok ? 2 : 0,
        maxScore: 2,
        reason: ok ? "enough structured fields" : "too few structured fields",
        actual: arrays
      });
    }
  }

  const score = details.reduce((sum, detail) => sum + detail.score, 0);
  const maxScore = details.reduce((sum, detail) => sum + detail.maxScore, 0);
  return {
    caseId: run.caseId,
    runIndex: run.runIndex,
    worker: run.worker,
    score,
    maxScore,
    validJson: true,
    details
  };
};

export const summarizeWorkerJsonBenchmark = (
  runs: WorkerJsonRunScore[]
): WorkerJsonBenchmarkSummary => {
  const totalScore = runs.reduce((sum, run) => sum + run.score, 0);
  const maxScore = runs.reduce((sum, run) => sum + run.maxScore, 0);
  return {
    runs,
    totalScore,
    maxScore,
    averageScoreRatio: maxScore > 0 ? totalScore / maxScore : 0,
    validJsonRate:
      runs.length > 0
        ? runs.filter((run) => run.validJson).length / runs.length
        : 0
  };
};
