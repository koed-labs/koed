import type { ActorContext, MemorySourceRepository } from "@koed/db";

type BundleRepository = Pick<
  MemorySourceRepository,
  "createShareBundle" | "changeRepresentationBundle"
>;

export const createShareBundle = (
  repository: BundleRepository,
  actor: ActorContext,
  input: Parameters<BundleRepository["createShareBundle"]>[1]
) => repository.createShareBundle(actor, input);

export const changeRepresentationBundle = (
  repository: BundleRepository,
  actor: ActorContext,
  input: Parameters<BundleRepository["changeRepresentationBundle"]>[1]
) => repository.changeRepresentationBundle(actor, input);
