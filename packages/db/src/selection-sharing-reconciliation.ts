import type pg from "pg";
import {
  sharingRuleSourceIdentityHash,
  crossIdentitySyncDigest,
  type EnvelopeEncryptionProvider,
  type SelectionSharingGoal
} from "@koed/shared";
import { createPersonalSelectionConsumerRepository } from "./personal-selection-consumer-repository.js";
import {
  createSelectionSharingJournal,
  type SelectionSharingProgressLease
} from "./selection-sharing-journal.js";

export type SelectionSharingInventoryReader = (
  lease: SelectionSharingProgressLease
) => Promise<unknown>;

/** One bounded phase per lease. Partial enumeration never becomes delivery work.
 * The journal, rather than an in-memory loop, owns progress across restarts. */
export const createSelectionSharingReconciliation = (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider
) => {
  const journal = createSelectionSharingJournal(pool, provider);
  const personal = createPersonalSelectionConsumerRepository(pool, {
    includeDeletedProjects: true
  });
  const step = async (
    lease: SelectionSharingProgressLease,
    readInventory?: SelectionSharingInventoryReader
  ) => {
    const actor = { userId: lease.identity.localOwnerUserId };
    const proposal = lease.data.proposal;
    if (!proposal || proposal.phase === "enumerating") {
      if (
        !proposal &&
        lease.data.changeCursor &&
        !("publisherTakeover" in lease.data.intent)
      ) {
        const changes = await personal.reconcilePersonalSelectionChanges(
          actor,
          { cursor: lease.data.changeCursor }
        );
        // Any nonempty or paged window needs a new complete baseline. Its
        // checkpoint remains installed until that replacement is complete.
        if (
          !changes.reconciliationRequired &&
          !changes.nextCursor &&
          changes.changeCursor
        ) {
          await journal.advanceCheckpoint(lease, changes.changeCursor);
          return;
        }
      }
      const page = proposal?.nextCursor
        ? await personal.continuePersonalSelectionEnumeration(actor, {
            cursor: proposal.nextCursor
          })
        : await personal.startPersonalSelectionEnumeration(actor, {
            target: lease.data.intent.review.target
          });
      await journal.appendPage(lease, page);
      return;
    }
    if (proposal.phase === "inventory") {
      const inventory = proposal.inventory;
      if (!inventory || !proposal.changeCursor)
        throw new Error("Inventory needs a complete Personal checkpoint");
      if (!inventory.page) {
        if (!readInventory)
          throw new Error("Publisher inventory transport unavailable");
        await journal.installInventoryPage(lease, await readInventory(lease));
        return;
      }
      const bindings = await journal.readPublisherTakeoverSourceBindings({
        ownerUserId: actor.userId,
        ...(inventory.afterBindingId
          ? { afterBindingId: inventory.afterBindingId }
          : {})
      });
      const known = bindings.entries.flatMap(({ source }) => {
        const portable = source.portable!;
        const hash = sharingRuleSourceIdentityHash(
          lease.identity.upstreamUserId,
          {
            originatingDeploymentId: portable.originatingDeploymentId,
            originatingDeviceId: portable.originatingDeviceId,
            logicalSessionId: portable.logicalSessionId
          }
        );
        const member = inventory.page!.entries.find(
          (entry) =>
            entry.portableSourceHash === hash &&
            inventory.unmatchedMembershipIds.includes(entry.membershipId)
        );
        return member ? [{ source, member }] : [];
      });
      const evaluation = known.length
        ? await personal.evaluatePersonalSelectionMembers(actor, {
            cursor: proposal.changeCursor,
            sources: known.map(({ source }) => ({
              localSessionId: source.localSessionId,
              localLogicalSessionId: source.localLogicalSessionId
            }))
          })
        : null;
      if (evaluation && evaluation.snapshotVersion !== proposal.snapshotVersion)
        throw new Error("Inventory evaluation changed snapshot");
      await journal.stageInventoryBindings(lease, {
        nextAfterBindingId: bindings.nextAfterBindingId,
        dispositions: known.map(({ source, member }) => {
          const evaluated = evaluation!.entries.find(
            (entry) =>
              entry.localSessionId === source.localSessionId &&
              entry.localLogicalSessionId === source.localLogicalSessionId
          );
          if (!evaluated)
            throw new Error("Inventory evaluation omitted a source");
          const goal: SelectionSharingGoal | null =
            evaluated.state === "matching"
              ? null
              : {
                  source: evaluated.contextVersion
                    ? { ...source, contextVersion: evaluated.contextVersion }
                    : source,
                  desired:
                    evaluated.state === "deleted" ||
                    evaluated.state === "not_matching"
                      ? "removed"
                      : "unresolved",
                  snapshotVersion: proposal.snapshotVersion,
                  contextHash:
                    evaluated.sourceContextHash ??
                    crossIdentitySyncDigest({
                      source,
                      selector: lease.data.intent.selector
                    })
                };
          return { membershipId: member.membershipId, source, goal };
        })
      });
      return;
    }
    if (proposal.phase === "present") {
      await journal.stagePresentPage(lease);
      return;
    }
    if (proposal.phase === "missing") {
      const missing = await journal.readMissing(lease);
      if (!missing.changeCursor)
        throw new Error("Completed selection has no checkpoint");
      const known = missing.entries.filter(
        (entry): entry is typeof entry & { goal: SelectionSharingGoal } =>
          entry.goal !== null
      );
      const evaluation = known.length
        ? await personal.evaluatePersonalSelectionMembers(actor, {
            cursor: missing.changeCursor,
            sources: known.map(({ goal }) => ({
              localSessionId: goal.source.localSessionId,
              localLogicalSessionId: goal.source.localLogicalSessionId
            }))
          })
        : null;
      if (evaluation && evaluation.snapshotVersion !== missing.snapshotVersion)
        throw new Error("Selection evaluation changed snapshot");
      await journal.stageMissing(
        lease,
        missing.entries.map((entry) => {
          if (!entry.goal) return entry;
          const previous = entry.goal;
          const evaluated = evaluation?.entries.find(
            (candidate) =>
              candidate.localSessionId === previous.source.localSessionId &&
              candidate.localLogicalSessionId ===
                previous.source.localLogicalSessionId
          );
          if (!evaluated)
            throw new Error("Selection evaluation omitted a known source");
          const conclusive = evaluated.state !== "unresolved";
          const goal: SelectionSharingGoal = {
            source: conclusive
              ? {
                  ...previous.source,
                  contextVersion: evaluated.contextVersion!
                }
              : previous.source,
            desired:
              evaluated.state === "deleted" ||
              evaluated.state === "not_matching"
                ? "removed"
                : "unresolved",
            snapshotVersion: missing.snapshotVersion,
            contextHash: evaluated.sourceContextHash ?? previous.contextHash
          };
          // A matching source missing from the available baseline still needs
          // its complete, verified source identity before any new admission.
          return { id: entry.id, goal };
        })
      );
      return;
    }
    await journal.commit(lease);
  };
  return {
    async reconcile(
      localOwnerUserId: string,
      limit = 5,
      readInventory?: SelectionSharingInventoryReader
    ) {
      const leases = await journal.claim(localOwnerUserId, limit);
      let advanced = 0;
      const failures: Array<{ progressId: string; code: string }> = [];
      for (const lease of leases) {
        try {
          await step(lease, readInventory);
          advanced++;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : "selection_reconciliation_unavailable";
          failures.push({ progressId: lease.progressId, code });
          try {
            if (
              [
                "selection_enumeration_stale",
                "selection_cursor_expired",
                "selection_cursor_unavailable"
              ].includes(code)
            ) {
              await journal.abandon(lease);
            } else await journal.defer(lease);
          } catch {
            // A revoked enrollment or replaced lease cannot be revived. A
            // transient database failure leaves this lease to expire normally.
          }
        }
      }
      return { advanced, failures };
    }
  };
};
