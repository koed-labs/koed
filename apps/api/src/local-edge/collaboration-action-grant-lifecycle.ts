import { randomBytes } from "node:crypto";

import {
  deleteCollaborationActionGrantCustody,
  markCollaborationActionGrantCustodyAmbiguous,
  readCollaborationActionGrantCustodyCommitmentHash,
  readCollaborationActionGrantCustodyStatus,
  resolveCollaborationActionGrantSecret,
  storeCollaborationActionGrantCustody,
  updateCollaborationActionGrantCustodyStatus,
  type CollaborationActionGrantAccessInput,
  type CollaborationApprovalReview,
  type CollaborationApprovalTier,
  type CollaborationActionGrantCustodyInput,
  type CollaborationActionGrantReference,
  type CollaborationActionGrantResolveInput
} from "@koed/shared";

import { highRiskActionGrantRemoteEnvelopeSchema } from "../high-risk/action-grant-protocol.js";
import {
  safeUpstreamProxyUrl,
  type LocalEdgeUpstreamBackend
} from "./upstream-routing.js";

export interface ActionGrantRemoteStatus {
  version: 1;
  actionGrant: { id: string };
  approvalTier: CollaborationApprovalTier;
  review: CollaborationApprovalReview | null;
  state:
    | "pending"
    | "review_required"
    | "approved"
    | "consumed"
    | "denied"
    | "revoked"
    | "expired"
    | "canceled";
  activationUrl: string | null;
  expiresAt: string;
}

export interface CollaborationActionGrantLifecycleContext {
  backend: LocalEdgeUpstreamBackend;
  localOwnerUserId?: string;
  principalUserId: string;
  upstreamDeviceCredentialId: string | null;
}

export interface CollaborationActionGrantLifecycle {
  prepare(input: CollaborationActionGrantCustodyInput): {
    referenceId: string;
    commitmentHash: string;
  };
  create(input: CollaborationActionGrantCustodyInput): {
    referenceId: string;
    commitmentHash: string;
  };
  read(
    context: CollaborationActionGrantLifecycleContext,
    reference: CollaborationActionGrantReference
  ): ActionGrantRemoteStatus | null;
  acceptRemote(
    context: CollaborationActionGrantLifecycleContext,
    reference: CollaborationActionGrantReference,
    payload: unknown
  ): ActionGrantRemoteStatus | null;
  markAmbiguous(
    context: CollaborationActionGrantLifecycleContext,
    reference: CollaborationActionGrantReference,
    status?: Pick<
      ActionGrantRemoteStatus,
      "actionGrant" | "approvalTier" | "review" | "state" | "activationUrl"
    >
  ): void;
  transitionTerminal(
    context: CollaborationActionGrantLifecycleContext,
    status: ActionGrantRemoteStatus,
    state: "consumed" | "denied" | "revoked" | "expired" | "canceled"
  ): ActionGrantRemoteStatus;
  discard(
    reference: CollaborationActionGrantReference,
    reason: "request_rejected" | "authority_lost" | "durable_outcome"
  ): void;
  resolve(input: CollaborationActionGrantResolveInput): string | null;
}

export const createCollaborationActionGrantLifecycle = (input: {
  koedHome: string;
  now?: () => Date;
  randomBytes?: typeof randomBytes;
  ambiguousResponseWindowMs?: number;
}): CollaborationActionGrantLifecycle => {
  const now = input.now ?? (() => new Date());
  const createRandomBytes = input.randomBytes ?? randomBytes;
  const ambiguousResponseWindowMs = input.ambiguousResponseWindowMs ?? 30_000;
  const access = (
    context: CollaborationActionGrantLifecycleContext,
    reference: CollaborationActionGrantReference
  ): CollaborationActionGrantAccessInput => ({
    referenceId: reference.id,
    backendId: context.backend.id,
    deploymentBaseUrl: context.backend.baseUrl,
    deviceCredentialId: context.upstreamDeviceCredentialId ?? "",
    ...(context.localOwnerUserId
      ? { localOwnerUserId: context.localOwnerUserId }
      : {}),
    principalUserId: context.principalUserId
  });

  const persistRemoteStatus = (
    context: CollaborationActionGrantLifecycleContext,
    status: ActionGrantRemoteStatus
  ): void => {
    const common = {
      ...access(context, status.actionGrant),
      approvalTier: status.approvalTier,
      review: status.review,
      expiresAt: status.expiresAt
    };
    if (status.state === "pending" || status.state === "review_required") {
      updateCollaborationActionGrantCustodyStatus(
        input.koedHome,
        {
          ...common,
          state: status.state,
          activationUrl: status.activationUrl
        },
        { now }
      );
      return;
    }
    updateCollaborationActionGrantCustodyStatus(
      input.koedHome,
      status.state === "approved"
        ? { ...common, state: "approved" }
        : { ...common, state: status.state },
      { now }
    );
  };

  const markAmbiguous = (
    context: CollaborationActionGrantLifecycleContext,
    reference: CollaborationActionGrantReference,
    status?: Pick<
      ActionGrantRemoteStatus,
      "actionGrant" | "approvalTier" | "review" | "state" | "activationUrl"
    >
  ): void => {
    if (
      status &&
      (status.state === "pending" ||
        status.state === "review_required" ||
        status.state === "approved")
    ) {
      const common = {
        ...access(context, reference),
        approvalTier: status.approvalTier,
        review: status.review,
        ambiguousUntil: new Date(
          now().getTime() + ambiguousResponseWindowMs
        ).toISOString()
      };
      updateCollaborationActionGrantCustodyStatus(
        input.koedHome,
        status.state === "approved"
          ? { ...common, state: "approved" }
          : {
              ...common,
              state: status.state,
              activationUrl: status.activationUrl
            },
        { now }
      );
      return;
    }
    markCollaborationActionGrantCustodyAmbiguous(
      input.koedHome,
      {
        ...access(context, reference),
        ambiguousUntil: new Date(
          now().getTime() + ambiguousResponseWindowMs
        ).toISOString()
      },
      { now }
    );
  };

  const remoteStatus = (
    context: CollaborationActionGrantLifecycleContext,
    payload: unknown
  ): ActionGrantRemoteStatus | null => {
    const parsed = highRiskActionGrantRemoteEnvelopeSchema.safeParse(payload);
    if (!parsed.success) return null;
    try {
      const activationUrl = parsed.data.status.activationPath
        ? safeUpstreamProxyUrl(
            context.backend,
            parsed.data.status.activationPath
          )
        : null;
      if (
        activationUrl &&
        (activationUrl.search ||
          activationUrl.hash ||
          activationUrl.toString().includes("hrg_"))
      ) {
        return null;
      }
      return {
        version: 1,
        actionGrant: parsed.data.status.actionGrant,
        approvalTier: parsed.data.status.approvalTier,
        review: parsed.data.status.review,
        state: parsed.data.status.state,
        activationUrl: activationUrl?.toString() ?? null,
        expiresAt: parsed.data.status.expiresAt
      };
    } catch {
      return null;
    }
  };

  return {
    prepare(custody) {
      const existingCommitment =
        readCollaborationActionGrantCustodyCommitmentHash(
          input.koedHome,
          {
            referenceId: custody.referenceId,
            backendId: custody.backendId,
            deploymentBaseUrl: custody.deploymentBaseUrl,
            deviceCredentialId: custody.deviceCredentialId,
            ...(custody.localOwnerUserId
              ? { localOwnerUserId: custody.localOwnerUserId }
              : {}),
            principalUserId: custody.principalUserId
          },
          { now }
        );
      if (existingCommitment) {
        return {
          referenceId: custody.referenceId,
          commitmentHash: existingCommitment
        };
      }
      return this.create(custody);
    },

    create(custody) {
      const stored = storeCollaborationActionGrantCustody(
        input.koedHome,
        custody,
        { now, randomBytes: createRandomBytes }
      );
      return {
        referenceId: stored.referenceId,
        commitmentHash: stored.commitmentHash
      };
    },

    read(context, reference) {
      return readCollaborationActionGrantCustodyStatus(
        input.koedHome,
        access(context, reference),
        { now }
      );
    },

    acceptRemote(context, reference, payload) {
      const status = remoteStatus(context, payload);
      if (!status || status.actionGrant.id !== reference.id) {
        markAmbiguous(context, reference);
        return null;
      }
      persistRemoteStatus(context, status);
      return status;
    },

    markAmbiguous,

    transitionTerminal(context, status, state) {
      const terminal = {
        ...status,
        state,
        activationUrl: null
      } satisfies ActionGrantRemoteStatus;
      persistRemoteStatus(context, terminal);
      return terminal;
    },

    discard(reference) {
      deleteCollaborationActionGrantCustody(input.koedHome, reference.id, {
        now
      });
    },

    resolve(resolveInput) {
      return resolveCollaborationActionGrantSecret(
        input.koedHome,
        resolveInput,
        { now }
      );
    }
  };
};
