import {
  crossIdentitySyncDigest,
  type SharedMemoryRepresentation
} from "@koed/shared";

export const defaultSharedMemoryRepresentations = [
  "memory_events",
  "lcm_leaves",
  "lcm_rollups"
] as const satisfies readonly SharedMemoryRepresentation[];

export const sharedMemoryPolicyHash = (input: {
  scope: "source_owner" | "team" | "workspace";
  scopeId: string;
  policyId: string;
  version: number;
  allowedRepresentations: SharedMemoryRepresentation[];
}): string => crossIdentitySyncDigest(input);
