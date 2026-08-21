export const sharedMemoryFidelityCeilings = [
  "lcm_rollups",
  "lcm_leaves",
  "memory_events"
] as const;

export type SharedMemoryFidelityCeiling =
  (typeof sharedMemoryFidelityCeilings)[number];

export type HierarchicalSharedMemoryRepresentation =
  SharedMemoryFidelityCeiling;

const fidelityRank: Record<SharedMemoryFidelityCeiling, number> = {
  lcm_rollups: 0,
  lcm_leaves: 1,
  memory_events: 2
};

export const sharedMemoryRepresentationsForCeiling = (
  ceiling: SharedMemoryFidelityCeiling
): HierarchicalSharedMemoryRepresentation[] =>
  sharedMemoryFidelityCeilings.filter(
    (representation) => fidelityRank[representation] <= fidelityRank[ceiling]
  );

export const sharedMemoryCeilingAuthorizes = (
  ceiling: SharedMemoryFidelityCeiling | null,
  representation: HierarchicalSharedMemoryRepresentation | "curated_assertions",
  curatedAssertionsEnabled = false
): boolean =>
  representation === "curated_assertions"
    ? curatedAssertionsEnabled
    : ceiling !== null && fidelityRank[representation] <= fidelityRank[ceiling];

export const intersectSharedMemoryFidelityCeilings = (
  ...ceilings: readonly (SharedMemoryFidelityCeiling | null)[]
): SharedMemoryFidelityCeiling | null => {
  if (ceilings.some((ceiling) => ceiling === null)) return null;
  return ceilings.reduce<SharedMemoryFidelityCeiling>(
    (current, ceiling) =>
      fidelityRank[ceiling!] < fidelityRank[current] ? ceiling! : current,
    "memory_events"
  );
};
