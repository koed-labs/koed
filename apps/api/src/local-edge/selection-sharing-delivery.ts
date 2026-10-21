import { randomUUID } from "node:crypto";
import {
  crossIdentitySyncDigest,
  selectionSharingEffectiveIntent,
  crossIdentitySyncDeterministicUuid,
  repositorySharingRuleMembersStateSchema,
  repositorySharingRuleMemberAcceptanceSchema,
  repositorySharingRuleMemberContextResultSchema,
  repositorySharingRuleMemberRemovalResultSchema,
  repositorySharingRuleMutationSettlementSchema,
  type SelectionSharingAttempt,
  type SelectionSharingSourceState,
  type SharedMemoryCandidatePreview
} from "@koed/shared";
import type {
  createSelectionSharingJournal,
  SelectionSharingSourceLease
} from "@koed/db";
import { createRepositorySharingRuleMemberSchema } from "../shared-memory/schemas.js";

type Journal = Pick<
  ReturnType<typeof createSelectionSharingJournal>,
  | "claimSources"
  | "resolveNativeSource"
  | "persistAttempt"
  | "acknowledgeSource"
  | "cancelAttempt"
  | "deferSource"
  | "recordDetailScope"
  | "recordContentPolicyScope"
>;
type PreparedAdmission = {
  candidate: SharedMemoryCandidatePreview;
  previewId: string;
  previewHash: string;
  previewRevision: number;
};
export interface SelectionSharingDeliveryTransport {
  deploymentProtocolId: string;
  inspect(logicalMemoryId: string): Promise<unknown>;
  prepareAdmission(logicalMemoryId: string): Promise<PreparedAdmission>;
  send(attempt: SelectionSharingAttempt): Promise<Record<string, unknown>>;
  cancel(attempt: SelectionSharingAttempt): Promise<unknown>;
  queueSource(input: {
    pendingShareId: string;
    mutationId: string;
    source: SharedMemoryCandidatePreview["source"];
    sourceRevision: number;
  }): Promise<void>;
}

/** A source has one exact outstanding write. Newer desired membership cannot
 * replace an ambiguous request; its original receipt is settled first. */
export const deliverSelectionSharingSources = async (options: {
  journal: Journal;
  localOwnerUserId: string;
  resolveTransport(
    lease: SelectionSharingSourceLease
  ): Promise<SelectionSharingDeliveryTransport>;
  limit?: number;
}) => {
  const leases = await options.journal.claimSources(
    options.localOwnerUserId,
    options.limit ?? 5
  );
  let acknowledged = 0;
  for (const lease of leases) {
    try {
      const transport = await options.resolveTransport(lease);
      let attempt = lease.data.attempt;
      if (!attempt) {
        if (
          lease.goal.desired === "unresolved" ||
          (lease.goal.desired === "removed" && !lease.data.remote)
        ) {
          await options.journal.acknowledgeSource(lease, {
            mutationId: null,
            remote: lease.data.remote
          });
          acknowledged++;
          continue;
        }
        const native =
          lease.goal.desired === "present"
            ? await options.journal.resolveNativeSource(
                lease,
                transport.deploymentProtocolId
              )
            : null;
        const logicalMemoryId =
          native?.logicalMemoryId ?? lease.data.remote?.logicalMemoryId;
        if (!logicalMemoryId || (lease.goal.desired === "present" && !native))
          throw new Error(
            "Source identity or current eligibility is unavailable"
          );
        const payload = await transport.inspect(logicalMemoryId);
        const state = repositorySharingRuleMembersStateSchema.parse(payload);
        const intent = selectionSharingEffectiveIntent(lease.progress);
        if (
          state.ruleId !== intent.ruleId ||
          state.selectorBindingHash !==
            crossIdentitySyncDigest(intent.selector) ||
          state.teamId !== intent.teamId ||
          state.teamWorkspaceId !== intent.teamWorkspaceId ||
          state.entries.length !== 1 ||
          state.entries[0]!.logicalMemoryId !== logicalMemoryId
        )
          throw new Error("Rule inspection does not match its approved scope");
        if (
          state.detailAmendment &&
          state.detailAmendment.result.authorityVersion >
            (lease.progress.detailAmendment?.result.authorityVersion ?? 1)
        ) {
          await options.journal.recordDetailScope({
            identity: lease.identity,
            remoteDeviceId: lease.remoteDeviceId,
            scope: state.detailAmendment
          });
          throw new Error(
            "Approved rule detail changed; renew this delivery lease"
          );
        }
        if (
          state.contentPolicyAmendment &&
          state.contentPolicyAmendment.result.authorityVersion >
            (lease.progress.contentPolicyAmendment?.result.authorityVersion ??
              1)
        ) {
          await options.journal.recordContentPolicyScope({
            identity: lease.identity,
            remoteDeviceId: lease.remoteDeviceId,
            scope: state.contentPolicyAmendment
          });
          throw new Error(
            "Approved rule content policy changed; renew this delivery lease"
          );
        }
        if (
          state.maximumFidelity !== intent.maximumFidelity ||
          state.includeCuratedMemory !== intent.includeCuratedMemory
        )
          throw new Error("Rule detail does not match its approved scope");
        const entry = state.entries[0]!;
        const remote: SelectionSharingSourceState["remote"] = {
          logicalMemoryId,
          membershipId: entry.member?.id ?? null,
          membershipVersion: entry.member?.version ?? null,
          authorityVersion: state.authorityVersion,
          publisherFence: state.publisherFence,
          pendingShareId: entry.member?.pendingShare?.id ?? null
        };
        if (
          state.state === "stopped" ||
          entry.member?.state === "revoked" ||
          (lease.goal.desired === "removed" &&
            (!entry.member || entry.member.state === "removed")) ||
          (lease.goal.desired === "present" &&
            entry.member?.state === "present" &&
            entry.member.sourceContextHash === lease.goal.contextHash &&
            entry.member.gitContextVersion ===
              lease.goal.source.contextVersion.git &&
            entry.member.folderContextVersion ===
              lease.goal.source.contextVersion.folder)
        ) {
          await options.journal.acknowledgeSource(lease, {
            mutationId: null,
            remote
          });
          acknowledged++;
          continue;
        }
        const mutationId = randomUUID();
        const membershipId =
          entry.member?.id ??
          crossIdentitySyncDeterministicUuid({
            kind: "sharing_rule_member",
            ruleId: intent.ruleId,
            logicalMemoryId
          });
        const context = {
          mutationId,
          selectionSnapshotVersion: lease.goal.snapshotVersion,
          sourceContextHash: lease.goal.contextHash,
          expectedAuthorityVersion: state.authorityVersion,
          expectedMembershipVersion: entry.member?.version ?? 0,
          publisherFence: state.publisherFence
        };
        let kind: SelectionSharingAttempt["kind"],
          body: SelectionSharingAttempt["body"];
        if (lease.goal.desired === "removed") {
          kind = "remove";
          body = context;
        } else if (entry.member?.state === "present") {
          kind = "context";
          body = {
            ...context,
            gitContextVersion: lease.goal.source.contextVersion.git,
            folderContextVersion: lease.goal.source.contextVersion.folder,
            selectorBindingHash: state.selectorBindingHash
          };
        } else {
          if (state.state !== "active")
            throw new Error("Paused rules cannot admit a source");
          const prepared = await transport.prepareAdmission(logicalMemoryId);
          const candidate = prepared.candidate;
          if (
            candidate.logicalMemoryId !== logicalMemoryId ||
            candidate.source.kind !== "captured_session" ||
            candidate.source.sessionId !== native!.sessionId ||
            candidate.mode !== "continuous" ||
            candidate.activationRepresentation !== intent.maximumFidelity
          )
            throw new Error("Candidate does not match the native source");
          kind = "admit";
          body = createRepositorySharingRuleMemberSchema.parse({
            mutationId,
            logicalGrantId: entry.grant?.logicalGrantId ?? randomUUID(),
            consentId: randomUUID(),
            source: candidate.source,
            sourceCapabilities: candidate.sourceCapabilities,
            activationRepresentation: candidate.activationRepresentation,
            logicalMemoryId,
            teamId: intent.teamId,
            teamWorkspaceId: intent.teamWorkspaceId,
            mode: "continuous",
            maximumFidelity: intent.maximumFidelity,
            includeCuratedMemory: intent.includeCuratedMemory,
            expiresAt: null,
            preview: {
              previewId: prepared.previewId,
              previewHash: prepared.previewHash
            },
            previewRevision: prepared.previewRevision,
            membership: {
              selectionSnapshotVersion: context.selectionSnapshotVersion,
              sourceContextHash: context.sourceContextHash,
              expectedAuthorityVersion: context.expectedAuthorityVersion,
              expectedMembershipVersion: context.expectedMembershipVersion,
              publisherFence: context.publisherFence,
              selectorBindingHash: state.selectorBindingHash,
              gitContextVersion: lease.goal.source.contextVersion.git,
              folderContextVersion: lease.goal.source.contextVersion.folder,
              expectedGrantVersion: entry.grant?.version ?? null
            }
          });
        }
        // Strict membership input has no mutation field; the mutation belongs
        // to the Pending Share request containing it.
        const request = { kind, logicalMemoryId, membershipId, body };
        attempt = await options.journal.persistAttempt(lease, {
          deliveryEpoch: lease.deliveryEpoch,
          mutationId,
          goalHash: lease.goalHash,
          ...request,
          requestHash: crossIdentitySyncDigest(request)
        });
      }
      let response: Record<string, unknown>;
      try {
        response = await transport.send(attempt);
      } catch {
        const settlement = repositorySharingRuleMutationSettlementSchema.parse(
          await transport.cancel(attempt)
        );
        if (
          settlement.ruleId !== lease.progress.intent.ruleId ||
          settlement.mutationId !== attempt.mutationId ||
          settlement.kind !== attempt.kind ||
          settlement.logicalMemoryId !== attempt.logicalMemoryId ||
          settlement.membershipId !== attempt.membershipId ||
          settlement.requestHash !== attempt.requestHash
        )
          throw new Error(
            "Mutation settlement does not match the exact outstanding request"
          );
        if (settlement.state === "canceled") {
          await options.journal.cancelAttempt(lease, {
            mutationId: attempt.mutationId,
            requestHash: attempt.requestHash
          });
          continue;
        }
        response =
          attempt.kind === "admit"
            ? { admission: settlement.receipt }
            : { member: settlement.receipt };
      }
      let remote: NonNullable<SelectionSharingSourceState["remote"]>;
      if (attempt.kind === "admit") {
        const receipt = repositorySharingRuleMemberAcceptanceSchema.parse(
          response.admission
        );
        const membership = attempt.body.membership as Record<string, unknown>;
        if (
          receipt.membershipId !== attempt.membershipId ||
          receipt.membershipVersion !==
            Number(membership.expectedMembershipVersion) + 1 ||
          receipt.authorityVersion !== membership.expectedAuthorityVersion ||
          receipt.publisherFence !== membership.publisherFence
        )
          throw new Error("Admission receipt does not match its request");
        const body = createRepositorySharingRuleMemberSchema.parse(
          attempt.body
        );
        await transport.queueSource({
          pendingShareId: receipt.pendingShareId,
          mutationId: attempt.mutationId,
          source: body.source,
          sourceRevision: receipt.sourceRevision
        });
        remote = {
          logicalMemoryId: attempt.logicalMemoryId,
          membershipId: receipt.membershipId,
          membershipVersion: receipt.membershipVersion,
          authorityVersion: receipt.authorityVersion,
          publisherFence: receipt.publisherFence,
          pendingShareId: receipt.pendingShareId
        };
      } else {
        const receipt = (
          attempt.kind === "remove"
            ? repositorySharingRuleMemberRemovalResultSchema
            : repositorySharingRuleMemberContextResultSchema
        ).parse(response.member);
        if (
          receipt.ruleId !== lease.progress.intent.ruleId ||
          receipt.membershipId !== attempt.membershipId ||
          receipt.membershipVersion !==
            Number(attempt.body.expectedMembershipVersion) + 1 ||
          receipt.authorityVersion !==
            Number(attempt.body.expectedAuthorityVersion) +
              (attempt.kind === "remove" ? 1 : 0)
        )
          throw new Error("Member receipt does not match its request");
        remote = {
          logicalMemoryId: attempt.logicalMemoryId,
          membershipId: receipt.membershipId,
          membershipVersion: receipt.membershipVersion,
          authorityVersion: receipt.authorityVersion,
          publisherFence: Number(attempt.body.publisherFence),
          pendingShareId: null
        };
      }
      await options.journal.acknowledgeSource(lease, {
        mutationId: attempt.mutationId,
        remote
      });
      acknowledged++;
    } catch {
      // Includes unknown remote outcomes. Do not replace a possibly accepted
      // write with a fresh mutation or discard it because its candidate expired.
      try {
        await options.journal.deferSource(lease);
      } catch {
        /* Revoked or replaced leases remain fenced. */
      }
    }
  }
  return { processed: leases.length, acknowledged };
};
