import type { ActorContext, MemorySourceRepository } from "@koed/db";

type BundleRepository = Pick<
  MemorySourceRepository,
  "createSourceOwnerConsent" | "createShareGrant" | "selectGrantRepresentation"
>;

type ConsentInput = Parameters<BundleRepository["createSourceOwnerConsent"]>[1];
type ShareGrantInput = Parameters<BundleRepository["createShareGrant"]>[1];
type RepresentationInput = Parameters<
  BundleRepository["selectGrantRepresentation"]
>[1];

interface ConsentBinding {
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  previewId: string;
  previewRevision: number;
  previewHash: string;
}

const consentMatches = (
  consent: Awaited<ReturnType<BundleRepository["createSourceOwnerConsent"]>>,
  expected: ConsentBinding
): boolean =>
  consent.logicalMemoryId === expected.logicalMemoryId &&
  consent.teamId === expected.teamId &&
  consent.teamWorkspaceId === expected.teamWorkspaceId &&
  consent.previewId === expected.previewId &&
  consent.previewRevision === expected.previewRevision &&
  consent.previewHash === expected.previewHash;

export const createShareBundle = async (
  repository: BundleRepository,
  actor: ActorContext,
  input: {
    consent: ConsentInput;
    grant: ShareGrantInput;
    expected: ConsentBinding & { consentId: string };
  }
) => {
  const consent = await repository.createSourceOwnerConsent(
    actor,
    input.consent
  );
  if (!consentMatches(consent, input.expected)) return null;
  const grant = await repository.createShareGrant(actor, input.grant);
  if (
    grant.logicalMemoryId !== input.expected.logicalMemoryId ||
    grant.teamId !== input.expected.teamId ||
    grant.teamWorkspaceId !== input.expected.teamWorkspaceId ||
    grant.consentId !== input.expected.consentId
  ) {
    return null;
  }
  return { consent, grant };
};

export const changeRepresentationBundle = async (
  repository: BundleRepository,
  actor: ActorContext,
  input: {
    consent: ConsentInput;
    representation: RepresentationInput;
    expected: ConsentBinding & {
      consentId: string;
      representation: string;
    };
  }
) => {
  const consent = await repository.createSourceOwnerConsent(
    actor,
    input.consent
  );
  if (!consentMatches(consent, input.expected)) return null;
  const grant = await repository.selectGrantRepresentation(
    actor,
    input.representation
  );
  if (
    grant.logicalMemoryId !== input.expected.logicalMemoryId ||
    grant.teamId !== input.expected.teamId ||
    grant.teamWorkspaceId !== input.expected.teamWorkspaceId ||
    grant.consentId !== input.expected.consentId ||
    grant.activeRepresentation !== input.expected.representation
  ) {
    return null;
  }
  return { consent, grant };
};
