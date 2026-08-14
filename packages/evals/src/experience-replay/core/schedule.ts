import { deepFreeze, immutableHash, sha256 } from "./hash.js";

export const NATURAL_CONDITIONS = [
  "cold",
  "empty",
  "placebo",
  "relevant"
] as const;
/** Public name for the natural replay conditions. */
export const CONDITIONS = NATURAL_CONDITIONS;
export const ORACLE_CONDITIONS = [
  "cold",
  "empty",
  "irrelevant",
  "relevant_guidance",
  "relevant_trace",
  "relevant_full"
] as const;
export const ORACLE_REPEATED_CONDITIONS = [
  "direct_guidance",
  "relevant_full",
  "relevant_guidance",
  "empty"
] as const;
export const ORACLE_CAMPAIGN_CONDITIONS = ["relevant_full"] as const;
export type NaturalReplayCondition = (typeof NATURAL_CONDITIONS)[number];
export type OracleReplayCondition = (typeof ORACLE_CONDITIONS)[number];
export type OracleRepeatedReplayCondition =
  (typeof ORACLE_REPEATED_CONDITIONS)[number];
export type ExperienceReplayCondition =
  | NaturalReplayCondition
  | OracleReplayCondition
  | OracleRepeatedReplayCondition;
export type ReplayCondition = ExperienceReplayCondition;
export type MemoryReplayCondition = Exclude<
  ExperienceReplayCondition,
  "cold" | "direct_guidance"
>;
export const conditionUsesKoed = (
  condition: ExperienceReplayCondition
): condition is MemoryReplayCondition =>
  condition !== "cold" && condition !== "direct_guidance";
export const WILLIAMS_ROWS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;
export const ORACLE_WILLIAMS_ROWS = [
  "ABFCED",
  "BCADFE",
  "CDBEAF",
  "DECFBA",
  "EFDACB",
  "FAEBDC"
] as const;
export const ORACLE_REPEATED_ROWS = ["ABDC", "BCAD", "CDBA", "DACB"] as const;

export type ReplayConditionSet =
  | readonly NaturalReplayCondition[]
  | readonly OracleReplayCondition[]
  | readonly OracleRepeatedReplayCondition[]
  | readonly (typeof ORACLE_CAMPAIGN_CONDITIONS)[number][];

export interface ScheduleEntry<
  Condition extends ExperienceReplayCondition = ReplayCondition
> {
  taskDigest: string;
  repeat: number;
  sequenceRow:
    | (typeof WILLIAMS_ROWS)[number]
    | (typeof ORACLE_WILLIAMS_ROWS)[number]
    | (typeof ORACLE_REPEATED_ROWS)[number]
    | "A";
  conditions: readonly Condition[];
}

export interface ReplaySchedule<
  Condition extends ExperienceReplayCondition = ReplayCondition
> {
  version: 1;
  seed: string;
  letterAssignment: Readonly<Record<string, Condition>>;
  entries: readonly ScheduleEntry<Condition>[];
  scheduleHash: string;
}

export interface FrozenReplayScheduleInputs<
  Condition extends ExperienceReplayCondition = ReplayCondition
> {
  taskDigests: readonly string[];
  repeats: number;
  seed: string;
  conditions?: readonly Condition[];
}

const sameConditions = (
  actual: readonly ExperienceReplayCondition[],
  expected: readonly ExperienceReplayCondition[]
): boolean =>
  actual.length === expected.length &&
  actual.every((condition, index) => condition === expected[index]);

const designFor = (conditions: readonly ExperienceReplayCondition[]) => {
  if (sameConditions(conditions, NATURAL_CONDITIONS)) {
    return { conditions: NATURAL_CONDITIONS, rows: WILLIAMS_ROWS } as const;
  }
  if (sameConditions(conditions, ORACLE_CONDITIONS)) {
    return {
      conditions: ORACLE_CONDITIONS,
      rows: ORACLE_WILLIAMS_ROWS
    } as const;
  }
  if (sameConditions(conditions, ORACLE_REPEATED_CONDITIONS)) {
    return {
      conditions: ORACLE_REPEATED_CONDITIONS,
      rows: ORACLE_REPEATED_ROWS
    } as const;
  }
  if (sameConditions(conditions, ORACLE_CAMPAIGN_CONDITIONS)) {
    return { conditions: ORACLE_CAMPAIGN_CONDITIONS, rows: ["A"] } as const;
  }
  throw new Error(
    "Replay conditions must be the natural, oracle proof, oracle repeated, or oracle campaign condition set"
  );
};

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

export const createReplaySchedule = <
  Condition extends ExperienceReplayCondition = ReplayCondition
>(
  taskDigests: readonly string[],
  repeats: number,
  seed: string,
  conditions: readonly Condition[] = CONDITIONS as unknown as readonly Condition[]
): Readonly<ReplaySchedule<Condition>> => {
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("Repeats must be a positive integer");
  if (new Set(taskDigests).size !== taskDigests.length)
    throw new Error("Task digests must be unique");
  const design = designFor(conditions);
  const shuffledConditions = seededOrder(design.conditions, seed, "letters");
  const letterAssignment = Object.fromEntries(
    shuffledConditions.map((condition, index) => [
      String.fromCharCode("A".charCodeAt(0) + index),
      condition
    ])
  ) as Record<string, Condition>;
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
    Number.parseInt(sha256(`${seed}\0row-offset`).slice(0, 8), 16) %
    design.rows.length;
  const entries = units.map((unit, index): ScheduleEntry<Condition> => {
    const sequenceRow = design.rows[
      (index + rowOffset) % design.rows.length
    ] as ScheduleEntry<Condition>["sequenceRow"];
    const conditions = [...sequenceRow].map(
      (letter) => letterAssignment[letter] as Condition
    );
    return { ...unit, sequenceRow, conditions };
  });
  const body = { version: 1 as const, seed, letterAssignment, entries };
  return deepFreeze({ ...body, scheduleHash: immutableHash(body) });
};

export const verifyReplaySchedule = <
  Condition extends ExperienceReplayCondition = ReplayCondition
>(
  schedule: ReplaySchedule<Condition>,
  frozenInputs?: FrozenReplayScheduleInputs<Condition>
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
      frozenInputs.seed,
      frozenInputs.conditions
    );
    if (regenerated.scheduleHash !== schedule.scheduleHash) {
      throw new Error("Replay schedule does not match frozen run inputs");
    }
  }
  const assigned: readonly ExperienceReplayCondition[] = Object.values(
    schedule.letterAssignment
  );
  const supportedConditions = [
    NATURAL_CONDITIONS,
    ORACLE_CONDITIONS,
    ORACLE_REPEATED_CONDITIONS,
    ORACLE_CAMPAIGN_CONDITIONS
  ].find(
    (conditions) =>
      assigned.length === conditions.length &&
      conditions.every((condition) => assigned.includes(condition))
  );
  if (!supportedConditions || new Set(assigned).size !== assigned.length) {
    throw new Error(
      "Schedule does not assign every mandatory condition exactly once"
    );
  }
  const validRows =
    supportedConditions === NATURAL_CONDITIONS
      ? WILLIAMS_ROWS
      : supportedConditions === ORACLE_CONDITIONS
        ? ORACLE_WILLIAMS_ROWS
        : supportedConditions === ORACLE_REPEATED_CONDITIONS
          ? ORACLE_REPEATED_ROWS
          : (["A"] as const);
  for (const entry of schedule.entries) {
    if (!(validRows as readonly string[]).includes(entry.sequenceRow))
      throw new Error(`Invalid Williams row ${entry.sequenceRow}`);
    const expectedConditions = [...entry.sequenceRow].map(
      (letter) => schedule.letterAssignment[letter]
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
