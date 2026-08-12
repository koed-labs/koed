import { canonicalJson, deepFreeze, immutableHash, sha256 } from "./hash.js";

export interface PlaceboCandidate {
  taskDigest: string;
  category: string;
  sourcePassed: boolean;
  sanitizedTokenQuartile: 0 | 1 | 2 | 3;
  expertTimeSeconds: number;
  resourceClass: string;
}

export interface PlaceboEdge {
  targetDigest: string;
  sourceDigest: string;
  cost: readonly [number, number, number, number];
  tieBreak: string;
}

export interface PlaceboAssignment {
  version: 1;
  seed: string;
  edges: readonly PlaceboEdge[];
  assignments: readonly { targetDigest: string; sourceDigest: string }[];
  assignmentHash: string;
}

const compareEdge = (a: PlaceboEdge, b: PlaceboEdge): number =>
  canonicalJson([a.tieBreak, a.targetDigest, a.sourceDigest]).localeCompare(
    canonicalJson([b.tieBreak, b.targetDigest, b.sourceDigest])
  );

const solveClass = (
  candidates: readonly PlaceboCandidate[],
  edges: readonly PlaceboEdge[]
) => {
  const tasks = [...candidates].sort((a, b) =>
    a.taskDigest.localeCompare(b.taskDigest)
  );
  if (tasks.length < 2) {
    throw new Error(
      `Resource class ${tasks[0]?.resourceClass ?? "<empty>"} has fewer than two tasks`
    );
  }
  const edgeMap = new Map(
    edges.map((edge) => [`${edge.targetDigest}\0${edge.sourceDigest}`, edge])
  );
  const maxExpert = edges.reduce(
    (maximum, edge) => Math.max(maximum, edge.cost[3]),
    0
  );
  const n = BigInt(tasks.length);
  const expertBase = BigInt(maxExpert) * n + 1n;
  const quartileBase = 3n * n + 1n;
  const mismatchBase = n + 1n;
  const orderedEdges = [...edges].sort(compareEdge);
  const tieRank = new Map(
    orderedEdges.map((edge, index) => [
      `${edge.targetDigest}\0${edge.sourceDigest}`,
      BigInt(index)
    ])
  );
  // Encode the complete assignment in target-digest order. Adding edge ranks is
  // insufficient: two assignments can have the same rank sum while differing
  // at the first target, where the seeded tie-break has already chosen one.
  const tieRadix = BigInt(orderedEdges.length);
  const targetWeight = new Map(
    tasks.map((task, index) => [
      task.taskDigest,
      tieRadix ** BigInt(tasks.length - index - 1)
    ])
  );
  const primaryScale = tieRadix ** BigInt(tasks.length);
  const scalar = (edge: PlaceboEdge): bigint => {
    const category = BigInt(edge.cost[0]);
    const passed = BigInt(edge.cost[1]);
    const quartile = BigInt(edge.cost[2]);
    const expert = BigInt(edge.cost[3]);
    const primary =
      ((category * mismatchBase + passed) * quartileBase + quartile) *
        expertBase +
      expert;
    const rank =
      tieRank.get(`${edge.targetDigest}\0${edge.sourceDigest}`) ?? 0n;
    const weight = targetWeight.get(edge.targetDigest) ?? 0n;
    return primary * primaryScale + rank * weight;
  };

  // BigInt Hungarian algorithm. Missing/self edges use an unreachable sentinel.
  const size = tasks.length;
  const maximumScalar = edges.reduce((maximum, edge) => {
    const value = scalar(edge);
    return value > maximum ? value : maximum;
  }, 0n);
  const infinity = (maximumScalar + 1n) * BigInt(2 * (tasks.length + 1));
  const matrix = tasks.map((target) =>
    tasks.map((source) => {
      const edge = edgeMap.get(`${target.taskDigest}\0${source.taskDigest}`);
      return edge ? scalar(edge) : infinity;
    })
  );
  const u = Array<bigint>(size + 1).fill(0n);
  const v = Array<bigint>(size + 1).fill(0n);
  const p = Array<number>(size + 1).fill(0);
  const way = Array<number>(size + 1).fill(0);
  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array<bigint>(size + 1).fill(infinity);
    const used = Array<boolean>(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0] as number;
      let delta = infinity;
      let j1 = 0;
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue;
        const current =
          (matrix[i0 - 1]?.[j - 1] ?? infinity) - (u[i0] ?? 0n) - (v[j] ?? 0n);
        if (current < (minv[j] ?? infinity)) {
          minv[j] = current;
          way[j] = j0;
        }
        if ((minv[j] ?? infinity) < delta) {
          delta = minv[j] ?? infinity;
          j1 = j;
        }
      }
      if (delta >= infinity / 2n)
        throw new Error(
          `No perfect derangement for resource class ${tasks[0]?.resourceClass}`
        );
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] ?? 0n) + delta;
          v[j] = (v[j] ?? 0n) - delta;
        } else {
          minv[j] = (minv[j] ?? infinity) - delta;
        }
      }
      j0 = j1;
    } while ((p[j0] ?? 0) !== 0);
    do {
      const j1 = way[j0] ?? 0;
      p[j0] = p[j1] ?? 0;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result: { targetDigest: string; sourceDigest: string }[] = [];
  for (let sourceIndex = 1; sourceIndex <= size; sourceIndex += 1) {
    const targetIndex = p[sourceIndex] as number;
    const target = tasks[targetIndex - 1];
    const source = tasks[sourceIndex - 1];
    if (
      !target ||
      !source ||
      matrix[targetIndex - 1]?.[sourceIndex - 1] === infinity
    ) {
      throw new Error(
        `No perfect derangement for resource class ${tasks[0]?.resourceClass}`
      );
    }
    result.push({
      targetDigest: target.taskDigest,
      sourceDigest: source.taskDigest
    });
  }
  return result.sort((a, b) => a.targetDigest.localeCompare(b.targetDigest));
};

export const assignMatchedPlacebos = (
  candidates: readonly PlaceboCandidate[],
  seed: string
): Readonly<PlaceboAssignment> => {
  if (!seed) throw new Error("Placebo seed must not be empty");
  const digests = new Set<string>();
  for (const candidate of candidates) {
    if (digests.has(candidate.taskDigest))
      throw new Error(`Duplicate task digest ${candidate.taskDigest}`);
    if (
      !Number.isSafeInteger(candidate.expertTimeSeconds) ||
      candidate.expertTimeSeconds < 0
    ) {
      throw new Error(`Invalid expert time for ${candidate.taskDigest}`);
    }
    digests.add(candidate.taskDigest);
  }
  const classes = new Map<string, PlaceboCandidate[]>();
  for (const candidate of candidates) {
    const values = classes.get(candidate.resourceClass) ?? [];
    values.push(candidate);
    classes.set(candidate.resourceClass, values);
  }
  const allEdges: PlaceboEdge[] = [];
  const assignments: { targetDigest: string; sourceDigest: string }[] = [];
  for (const classCandidates of [...classes.values()]) {
    const edges: PlaceboEdge[] = [];
    for (const target of classCandidates) {
      for (const source of classCandidates) {
        if (target.taskDigest === source.taskDigest) continue;
        edges.push({
          targetDigest: target.taskDigest,
          sourceDigest: source.taskDigest,
          cost: [
            Number(target.category !== source.category),
            Number(target.sourcePassed !== source.sourcePassed),
            Math.abs(
              target.sanitizedTokenQuartile - source.sanitizedTokenQuartile
            ),
            Math.abs(target.expertTimeSeconds - source.expertTimeSeconds)
          ],
          tieBreak: sha256(
            `${seed}\0${target.taskDigest}\0${source.taskDigest}`
          )
        });
      }
    }
    allEdges.push(...edges);
    assignments.push(...solveClass(classCandidates, edges));
  }
  allEdges.sort(
    (a, b) =>
      a.targetDigest.localeCompare(b.targetDigest) ||
      a.sourceDigest.localeCompare(b.sourceDigest)
  );
  assignments.sort((a, b) => a.targetDigest.localeCompare(b.targetDigest));
  const assignmentHash = immutableHash({
    version: 1,
    seed,
    edges: allEdges,
    assignments
  });
  return deepFreeze({
    version: 1,
    seed,
    edges: allEdges,
    assignments,
    assignmentHash
  });
};

export const assignProductPathProofPlacebo = (
  target: PlaceboCandidate,
  donor: PlaceboCandidate,
  seed: string
): Readonly<PlaceboAssignment> => {
  if (!seed) throw new Error("Placebo seed must not be empty");
  if (target.taskDigest === donor.taskDigest) {
    throw new Error("Product-path proof target and donor must be distinct");
  }
  if (target.resourceClass !== donor.resourceClass) {
    throw new Error(
      "Product-path proof target and donor must be resource-compatible"
    );
  }
  for (const candidate of [target, donor]) {
    if (
      !Number.isSafeInteger(candidate.expertTimeSeconds) ||
      candidate.expertTimeSeconds < 0
    ) {
      throw new Error(`Invalid expert time for ${candidate.taskDigest}`);
    }
  }
  const edge: PlaceboEdge = {
    targetDigest: target.taskDigest,
    sourceDigest: donor.taskDigest,
    cost: [
      Number(target.category !== donor.category),
      Number(target.sourcePassed !== donor.sourcePassed),
      Math.abs(target.sanitizedTokenQuartile - donor.sanitizedTokenQuartile),
      Math.abs(target.expertTimeSeconds - donor.expertTimeSeconds)
    ],
    tieBreak: sha256(`${seed}\0${target.taskDigest}\0${donor.taskDigest}`)
  };
  const body = {
    version: 1 as const,
    seed,
    edges: [edge],
    assignments: [
      { targetDigest: target.taskDigest, sourceDigest: donor.taskDigest }
    ]
  };
  return deepFreeze({ ...body, assignmentHash: immutableHash(body) });
};

export const verifyPlaceboAssignment = (
  assignment: PlaceboAssignment
): void => {
  const expected = immutableHash({
    version: assignment.version,
    seed: assignment.seed,
    edges: assignment.edges,
    assignments: assignment.assignments
  });
  if (expected !== assignment.assignmentHash)
    throw new Error("Placebo assignment hash mismatch");
};
