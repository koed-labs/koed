import type { ActorContext, MemorySourceRepository } from "@koed/db";

type BundleRepository = Pick<
  MemorySourceRepository,
  "createShareBundle" | "changeFidelityBundle"
>;

export const createShareBundle = (
  repository: BundleRepository,
  actor: ActorContext,
  input: Parameters<BundleRepository["createShareBundle"]>[1]
) => repository.createShareBundle(actor, input);

export const changeFidelityBundle = (
  repository: BundleRepository,
  actor: ActorContext,
  input: Parameters<BundleRepository["changeFidelityBundle"]>[1]
) => repository.changeFidelityBundle(actor, input);
