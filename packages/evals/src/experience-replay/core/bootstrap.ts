import { sha256 } from "./hash.js";
import type {
  Comparison,
  ReplayOutcome,
  TaskRewardContract
} from "./metrics.js";
import { CONDITIONS, type ReplayCondition } from "./schedule.js";

export interface BootstrapInterval {
  lower: number;
  upper: number;
  resamples: number;
  method: "matched-repeat-block" | "complete-task";
}

const rngFromSeed = (seed: string): (() => number) => {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const percentile = (sorted: readonly number[], probability: number): number => {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return (
    (sorted[lower] as number) +
    fraction *
      ((sorted[Math.min(lower + 1, sorted.length - 1)] as number) -
        (sorted[lower] as number))
  );
};

const interval = (
  samples: number[],
  resamples: number,
  method: BootstrapInterval["method"]
): BootstrapInterval => {
  samples.sort((a, b) => a - b);
  return {
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    resamples,
    method
  };
};

interface CompleteBlock {
  taskDigest: string;
  repeat: number;
  rewards: Record<ReplayCondition, number>;
}

const completeBlocks = (
  outcomes: readonly ReplayOutcome[]
): CompleteBlock[] => {
  const grouped = new Map<string, ReplayOutcome[]>();
  const identities = new Set<string>();
  for (const outcome of outcomes) {
    const identity = `${outcome.taskDigest}\0${outcome.condition}\0${outcome.repeat}`;
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate replay outcome ${identity.replaceAll("\0", "/")}`
      );
    }
    identities.add(identity);
    const key = `${outcome.taskDigest}\0${outcome.repeat}`;
    const values = grouped.get(key) ?? [];
    values.push(outcome);
    grouped.set(key, values);
  }
  const blocks: CompleteBlock[] = [];
  for (const values of grouped.values()) {
    if (
      CONDITIONS.some(
        (condition) =>
          !values.some(
            (value) => value.condition === condition && value.reward !== null
          )
      )
    )
      continue;
    const first = values[0] as ReplayOutcome;
    blocks.push({
      taskDigest: first.taskDigest,
      repeat: first.repeat,
      rewards: Object.fromEntries(
        CONDITIONS.map((condition) => [
          condition,
          values.find((value) => value.condition === condition)?.reward
        ])
      ) as Record<ReplayCondition, number>
    });
  }
  return blocks;
};

export const matchedRepeatBlockBootstrap = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  options: { seed: string; resamples?: number }
): BootstrapInterval => {
  const resamples = options.resamples ?? 10_000;
  if (!Number.isInteger(resamples) || resamples < 1)
    throw new Error("Bootstrap resamples must be positive");
  const blocks = completeBlocks(outcomes);
  const byTask = contracts.map((contract) =>
    blocks.filter((block) => block.taskDigest === contract.taskDigest)
  );
  if (byTask.some((taskBlocks) => taskBlocks.length === 0)) {
    throw new Error(
      "Matched repeat-block bootstrap requires a complete four-condition block for every task"
    );
  }
  const random = rngFromSeed(options.seed);
  const samples: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    const taskDeltas = byTask.map((taskBlocks) => {
      const selected = Array.from(
        { length: taskBlocks.length },
        () =>
          taskBlocks[Math.floor(random() * taskBlocks.length)] as CompleteBlock
      );
      return (
        selected.reduce(
          (total, block) =>
            total +
            block.rewards[comparison.left] -
            block.rewards[comparison.right],
          0
        ) / selected.length
      );
    });
    samples.push(
      taskDeltas.reduce((total, value) => total + value, 0) / taskDeltas.length
    );
  }
  return interval(samples, resamples, "matched-repeat-block");
};

export const completeTaskBootstrap = (
  outcomes: readonly ReplayOutcome[],
  contracts: readonly TaskRewardContract[],
  comparison: Comparison,
  options: { seed: string; resamples?: number }
): BootstrapInterval => {
  const resamples = options.resamples ?? 10_000;
  if (!Number.isInteger(resamples) || resamples < 1)
    throw new Error("Bootstrap resamples must be positive");
  const blocks = completeBlocks(outcomes);
  const repeatIds = [
    ...new Set(outcomes.map((outcome) => outcome.repeat))
  ].sort((a, b) => a - b);
  const records = contracts
    .map((contract) => {
      const taskBlocks = blocks.filter(
        (block) => block.taskDigest === contract.taskDigest
      );
      if (
        taskBlocks.length !== repeatIds.length ||
        repeatIds.some(
          (repeat) => !taskBlocks.some((block) => block.repeat === repeat)
        )
      )
        return null;
      return (
        taskBlocks.reduce(
          (total, block) =>
            total +
            block.rewards[comparison.left] -
            block.rewards[comparison.right],
          0
        ) / taskBlocks.length
      );
    })
    .filter((value): value is number => value !== null);
  if (records.length !== contracts.length)
    throw new Error("Complete-task bootstrap requires complete task records");
  const random = rngFromSeed(options.seed);
  const samples = Array.from({ length: resamples }, () => {
    const selected = Array.from(
      { length: records.length },
      () => records[Math.floor(random() * records.length)] as number
    );
    return (
      selected.reduce((total, value) => total + value, 0) / selected.length
    );
  });
  return interval(samples, resamples, "complete-task");
};
