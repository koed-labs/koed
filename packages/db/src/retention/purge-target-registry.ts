import type { PoolClient } from "pg";

import type {
  PurgeArtifactKind,
  PurgeEvidenceState,
  RequiredPurgeArtifact,
  RetentionDecisionTarget
} from "../retention-lifecycle-repository.js";

export type ExecutablePurgeTarget = Extract<
  RetentionDecisionTarget,
  { kind: "team" | "share_grant" | "owner_private_replica" }
>;

export type ExecutablePurgeTargetKind = ExecutablePurgeTarget["kind"];

type TargetFor<Kind extends ExecutablePurgeTargetKind> = Extract<
  ExecutablePurgeTarget,
  { kind: Kind }
>;

export interface PurgeArtifactCleanupResult {
  state: Exclude<PurgeEvidenceState, "pending" | "failed">;
  removedRecordCount: number;
  removedByteCount: number;
  backupExpiresAt?: Date | null;
}

export interface PurgeCompletionContext {
  retentionDecisionId: string;
  purgeJobId: string;
  completedAt: Date;
  verifiedArtifactCount: number;
}

export interface PurgeTargetStrategy<Kind extends ExecutablePurgeTargetKind> {
  requiredArtifacts(
    target: TargetFor<Kind>,
    suppliedArtifacts?: RequiredPurgeArtifact[]
  ): RequiredPurgeArtifact[];
  validateEvidenceArtifacts(
    target: TargetFor<Kind>,
    actualArtifacts: RequiredPurgeArtifact[]
  ): void;
  lockTarget(client: PoolClient, target: TargetFor<Kind>): Promise<void>;
  prepareForClaim(
    client: PoolClient,
    target: TargetFor<Kind>,
    observedAt: Date
  ): Promise<void>;
  validateAttempt(
    target: TargetFor<Kind>,
    attempt: { teamId: string | null }
  ): void;
  cleanupArtifact(
    client: PoolClient,
    input: {
      target: TargetFor<Kind>;
      artifactKind: PurgeArtifactKind;
      observedAt: Date;
      backupExpiresAt: Date;
    }
  ): Promise<PurgeArtifactCleanupResult>;
  beforeJobCompletion(
    client: PoolClient,
    target: TargetFor<Kind>,
    context: PurgeCompletionContext
  ): Promise<void>;
  afterJobCompletion(
    client: PoolClient,
    target: TargetFor<Kind>,
    context: PurgeCompletionContext
  ): Promise<void>;
}

export type PurgeTargetStrategyRegistry = {
  [Kind in ExecutablePurgeTargetKind]: PurgeTargetStrategy<Kind>;
};

export const definePurgeTargetStrategyRegistry = (
  registry: PurgeTargetStrategyRegistry
): PurgeTargetStrategyRegistry => registry;

type ErasedPurgeTargetStrategy = {
  requiredArtifacts(
    target: ExecutablePurgeTarget,
    suppliedArtifacts?: RequiredPurgeArtifact[]
  ): RequiredPurgeArtifact[];
  validateEvidenceArtifacts(
    target: ExecutablePurgeTarget,
    actualArtifacts: RequiredPurgeArtifact[]
  ): void;
  lockTarget(client: PoolClient, target: ExecutablePurgeTarget): Promise<void>;
  prepareForClaim(
    client: PoolClient,
    target: ExecutablePurgeTarget,
    observedAt: Date
  ): Promise<void>;
  validateAttempt(
    target: ExecutablePurgeTarget,
    attempt: { teamId: string | null }
  ): void;
  cleanupArtifact(
    client: PoolClient,
    input: {
      target: ExecutablePurgeTarget;
      artifactKind: PurgeArtifactKind;
      observedAt: Date;
      backupExpiresAt: Date;
    }
  ): Promise<PurgeArtifactCleanupResult>;
  beforeJobCompletion(
    client: PoolClient,
    target: ExecutablePurgeTarget,
    context: PurgeCompletionContext
  ): Promise<void>;
  afterJobCompletion(
    client: PoolClient,
    target: ExecutablePurgeTarget,
    context: PurgeCompletionContext
  ): Promise<void>;
};

const strategyFor = (
  registry: PurgeTargetStrategyRegistry,
  target: ExecutablePurgeTarget
): ErasedPurgeTargetStrategy =>
  registry[target.kind] as unknown as ErasedPurgeTargetStrategy;

export const requiredArtifactsForPurgeTarget = (
  registry: PurgeTargetStrategyRegistry,
  target: ExecutablePurgeTarget,
  suppliedArtifacts?: RequiredPurgeArtifact[]
): RequiredPurgeArtifact[] =>
  strategyFor(registry, target).requiredArtifacts(target, suppliedArtifacts);

export const validatePurgeTargetEvidenceArtifacts = (
  registry: PurgeTargetStrategyRegistry,
  target: ExecutablePurgeTarget,
  actualArtifacts: RequiredPurgeArtifact[]
): void =>
  strategyFor(registry, target).validateEvidenceArtifacts(
    target,
    actualArtifacts
  );

export const lockPurgeTarget = (
  registry: PurgeTargetStrategyRegistry,
  client: PoolClient,
  target: ExecutablePurgeTarget
): Promise<void> => strategyFor(registry, target).lockTarget(client, target);

export const preparePurgeTargetForClaim = (
  registry: PurgeTargetStrategyRegistry,
  client: PoolClient,
  target: ExecutablePurgeTarget,
  observedAt: Date
): Promise<void> =>
  strategyFor(registry, target).prepareForClaim(client, target, observedAt);

export const validatePurgeTargetAttempt = (
  registry: PurgeTargetStrategyRegistry,
  target: ExecutablePurgeTarget,
  attempt: { teamId: string | null }
): void => strategyFor(registry, target).validateAttempt(target, attempt);

export const cleanupPurgeTargetArtifact = (
  registry: PurgeTargetStrategyRegistry,
  client: PoolClient,
  input: {
    target: ExecutablePurgeTarget;
    artifactKind: PurgeArtifactKind;
    observedAt: Date;
    backupExpiresAt: Date;
  }
): Promise<PurgeArtifactCleanupResult> =>
  strategyFor(registry, input.target).cleanupArtifact(client, input);

export const preparePurgeTargetCompletion = (
  registry: PurgeTargetStrategyRegistry,
  client: PoolClient,
  target: ExecutablePurgeTarget,
  context: PurgeCompletionContext
): Promise<void> =>
  strategyFor(registry, target).beforeJobCompletion(client, target, context);

export const recordPurgeTargetCompletion = (
  registry: PurgeTargetStrategyRegistry,
  client: PoolClient,
  target: ExecutablePurgeTarget,
  context: PurgeCompletionContext
): Promise<void> =>
  strategyFor(registry, target).afterJobCompletion(client, target, context);
