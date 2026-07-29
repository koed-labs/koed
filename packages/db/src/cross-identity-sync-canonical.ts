import {
  crossIdentitySyncDigest,
  type CapturedSessionSyncContributorV1,
  type CapturedSessionSyncEventV1
} from "@koed/shared";

const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBoundedJsonValue = (
  value: unknown,
  state: { depth: number; nodes: number }
): boolean => {
  if (state.depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    return false;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    isFiniteNumber(value) ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item, index) =>
      isBoundedJsonValue(item, {
        depth: state.depth + 1,
        nodes: state.nodes + index + 1
      })
    );
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every(([key, nested], index) => {
    if (key.length > 240) {
      return false;
    }
    return isBoundedJsonValue(nested, {
      depth: state.depth + 1,
      nodes: state.nodes + index + 1
    });
  });
};

export const canonicalSyncJsonObject = (
  value: unknown,
  field: string
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isBoundedJsonValue(value, { depth: 0, nodes: 0 })
  ) {
    throw new Error(`${field} must be a bounded JSON object`);
  }
  return value as Record<string, unknown>;
};

export const capturedSessionSyncContentFromUnknown = (
  value: unknown
): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(capturedSessionSyncContentFromUnknown)
      .filter(Boolean)
      .join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["content", "text", "message", "output", "result"]) {
    const content = capturedSessionSyncContentFromUnknown(record[key]);
    if (content) return content;
  }
  return "";
};

export const buildCapturedSessionSyncContributor = (
  input: Omit<CapturedSessionSyncContributorV1, "revisionHash">
): CapturedSessionSyncContributorV1 => {
  const canonical = {
    ...input,
    rawJson: input.rawJson,
    metadata: canonicalSyncJsonObject(input.metadata, "metadata")
  };
  return {
    ...canonical,
    revisionHash: crossIdentitySyncDigest(canonical)
  };
};

export const capturedSessionSyncManifestMatchesContributors = (
  metadata: Record<string, unknown>,
  contributors: CapturedSessionSyncContributorV1[]
): boolean => {
  const manifest = metadata.semanticItemManifest;
  if (manifest === undefined) {
    return contributors.length === 0;
  }
  if (!Array.isArray(manifest)) return false;
  const manifestSourceIds: string[] = [];
  for (const value of manifest) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const sourceIds = (value as Record<string, unknown>).sourceIds;
    if (
      !Array.isArray(sourceIds) ||
      sourceIds.length === 0 ||
      sourceIds.some(
        (sourceId) => typeof sourceId !== "string" || sourceId.length === 0
      )
    ) {
      return false;
    }
    manifestSourceIds.push(...(sourceIds as string[]));
  }
  const contributorIds = contributors.map(
    (contributor) => contributor.originItemId
  );
  const uniqueManifestIds = new Set(manifestSourceIds);
  const uniqueContributorIds = new Set(contributorIds);
  return (
    uniqueManifestIds.size === manifestSourceIds.length &&
    uniqueContributorIds.size === contributorIds.length &&
    uniqueManifestIds.size === uniqueContributorIds.size &&
    [...uniqueManifestIds].every((sourceId) =>
      uniqueContributorIds.has(sourceId)
    )
  );
};

export const buildCapturedSessionSyncEvent = (
  input: Omit<CapturedSessionSyncEventV1, "revisionHash">
): CapturedSessionSyncEventV1 => {
  const canonical = {
    ...input,
    metadata: canonicalSyncJsonObject(input.metadata, "metadata"),
    contributors: input.contributors
  };
  return {
    ...canonical,
    revisionHash: crossIdentitySyncDigest(canonical)
  };
};
