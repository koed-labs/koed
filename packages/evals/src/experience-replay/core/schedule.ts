import { deepFreeze, immutableHash, sha256 } from "./hash.js";

export const CONDITIONS = ["cold", "empty", "placebo", "relevant"] as const;
export type ReplayCondition = (typeof CONDITIONS)[number];
export const WILLIAMS_ROWS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;

export interface ScheduleEntry {
  taskDigest: string;
  repeat: number;
  sequenceRow: (typeof WILLIAMS_ROWS)[number];
  conditions: readonly ReplayCondition[];
}

export interface ReplaySchedule {
  version: 1;
  seed: string;
  letterAssignment: Readonly<Record<"A" | "B" | "C" | "D", ReplayCondition>>;
  entries: readonly ScheduleEntry[];
  scheduleHash: string;
}

export interface FrozenReplayScheduleInputs {
  taskDigests: readonly string[];
  repeats: number;
  seed: string;
}

const seededOrder = <T extends string>(
  items: readonly T[],
  seed: string,
  namespace: string
): T[] =>
  [...items].sort(
    (a, b) =>
      sha256(`${seed}\0${namespace}\0${a}`).localeCompare(
        sha256(`${seed}\0${namespace}\0${b}`)
      ) || a.localeCompare(b)
  );

export const createReplaySchedule = (
  taskDigests: readonly string[],
  repeats: number,
  seed: string
): Readonly<ReplaySchedule> => {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("Repeats must be a positive integer");
  if (new Set(taskDigests).size !== taskDigests.length)
    throw new Error("Task digests must be unique");
  const shuffledConditions = seededOrder(CONDITIONS, seed, "letters");
  const letterAssignment = {
    A: shuffledConditions[0] as ReplayCondition,
    B: shuffledConditions[1] as ReplayCondition,
    C: shuffledConditions[2] as ReplayCondition,
    D: shuffledConditions[3] as ReplayCondition
  };
  const units = taskDigests.flatMap((taskDigest) =>
    Array.from({ length: repeats }, (_, repeat) => ({ taskDigest, repeat }))
  );
  units.sort(
    (a, b) =>
      sha256(`${seed}\0unit\0${a.taskDigest}\0${a.repeat}`).localeCompare(
        sha256(`${seed}\0unit\0${b.taskDigest}\0${b.repeat}`)
      ) ||
      a.taskDigest.localeCompare(b.taskDigest) ||
      a.repeat - b.repeat
  );
  const rowOffset =
    Number.parseInt(sha256(`${seed}\0row-offset`).slice(0, 8), 16) % 4;
  const entries = units.map((unit, index): ScheduleEntry => {
    const sequenceRow = WILLIAMS_ROWS[
      (index + rowOffset) % 4
    ] as (typeof WILLIAMS_ROWS)[number];
    const conditions = [...sequenceRow].map(
      (letter) => letterAssignment[letter as "A" | "B" | "C" | "D"]
    );
    return { ...unit, sequenceRow, conditions };
  });
  const body = { version: 1 as const, seed, letterAssignment, entries };
  return deepFreeze({ ...body, scheduleHash: immutableHash(body) });
};

export const verifyReplaySchedule = (
  schedule: ReplaySchedule,
  frozenInputs?: FrozenReplayScheduleInputs
): void => {
  const expected = immutableHash({
    version: schedule.version,
    seed: schedule.seed,
    letterAssignment: schedule.letterAssignment,
    entries: schedule.entries
  });
  if (expected !== schedule.scheduleHash)
    throw new Error("Immutable replay schedule hash mismatch");
  if (frozenInputs) {
    const regenerated = createReplaySchedule(
      frozenInputs.taskDigests,
      frozenInputs.repeats,
      frozenInputs.seed
    );
    if (regenerated.scheduleHash !== schedule.scheduleHash) {
      throw new Error("Replay schedule does not match frozen run inputs");
    }
  }
  const assigned = Object.values(schedule.letterAssignment);
  if (
    new Set(assigned).size !== 4 ||
    CONDITIONS.some((condition) => !assigned.includes(condition))
  ) {
    throw new Error(
      "Schedule does not assign every mandatory condition exactly once"
    );
  }
  for (const entry of schedule.entries) {
    if (!WILLIAMS_ROWS.includes(entry.sequenceRow))
      throw new Error(`Invalid Williams row ${entry.sequenceRow}`);
    const expectedConditions = [...entry.sequenceRow].map(
      (letter) => schedule.letterAssignment[letter as "A" | "B" | "C" | "D"]
    );
    if (
      expectedConditions.some(
        (condition, index) => condition !== entry.conditions[index]
      )
    ) {
      throw new Error(
        `Schedule entry mapping mismatch for ${entry.taskDigest}/${entry.repeat}`
      );
    }
  }
};
