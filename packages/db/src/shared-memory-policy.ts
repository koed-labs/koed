import {
  crossIdentitySyncDigest,
  type SharedMemoryFidelityCeiling
} from "@koed/shared";

export const defaultSharedMemoryMaximumFidelity =
  "memory_events" satisfies SharedMemoryFidelityCeiling;
export const defaultSharedMemoryIncludesCuratedMemory = false;

export const sharedMemoryPolicyHash = (input: {
  scope: "source_owner" | "team" | "workspace";
  scopeId: string;
  policyId: string;
  version: number;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}): string => crossIdentitySyncDigest(input);
