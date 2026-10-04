import type { PersonalRemovalTarget } from "@/lib/personal-removals-client";

export function samePersonalRemoval(
  left: PersonalRemovalTarget,
  right: PersonalRemovalTarget
) {
  if (left.kind !== right.kind) return false;
  return left.kind === "project"
    ? left.projectId ===
        (right as Extract<PersonalRemovalTarget, { kind: "project" }>).projectId
    : left.sourceId ===
        (right as Extract<PersonalRemovalTarget, { kind: "conversation" }>)
          .sourceId;
}

export function personalRemovalsLoadMayApply(
  requestRevision: number,
  currentRevision: number
): boolean {
  return requestRevision === currentRevision;
}

export function applyPersonalRemoval(
  removals: readonly PersonalRemovalTarget[],
  target: PersonalRemovalTarget,
  removed: boolean
): PersonalRemovalTarget[] {
  const remaining = removals.filter(
    (item) => !samePersonalRemoval(item, target)
  );
  return removed ? [...remaining, target] : remaining;
}
