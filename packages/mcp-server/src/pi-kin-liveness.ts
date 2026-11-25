import type { FloatingKinActivity } from "@koed-labs/shared";
import { z } from "zod";

const leaseMs = 15_000;
const publisherLimit = 64;
const futureToleranceMs = 1_000;

export const piKinSignalSchema = z.strictObject({
  externalSessionId: z.string().min(1).max(1024),
  publisherId: z.string().uuid(),
  sequence: z.number().int().positive(),
  observedAt: z.number().int().positive(),
  working: z.boolean()
});

type PiKinSignal = z.infer<typeof piKinSignalSchema>;
type Lease = {
  externalSessionId: string;
  sequence: number;
  expiresAt: number;
  verified?: { sessionId: string; expiresAt: number };
};

type PiKinScope = {
  connectionRevision(): number | undefined;
  resolveSession(id: string, signal: AbortSignal): Promise<string | undefined>;
  allowsPersonalStatus(id: string, signal: AbortSignal): Promise<boolean>;
};

export class PiKinLiveness {
  private revision: number | undefined;
  private readonly publishers = new Map<string, Lease>();

  constructor(private readonly scope: PiKinScope) {}

  private refreshScope(now: number): boolean {
    const revision = this.scope.connectionRevision();
    if (revision !== this.revision) {
      this.publishers.clear();
      this.revision = revision;
    }
    for (const [id, lease] of this.publishers) {
      if (lease.expiresAt <= now) this.publishers.delete(id);
    }
    return revision !== undefined;
  }

  async update(input: PiKinSignal, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    if (
      !this.refreshScope(now) ||
      input.observedAt > now + futureToleranceMs ||
      input.observedAt <= now - leaseMs
    )
      return;
    const publisher = input.publisherId.toLowerCase();
    const current = this.publishers.get(publisher);
    if (current && current.sequence >= input.sequence) return;
    if (!current && this.publishers.size >= publisherLimit) return;
    const expiresAt = Math.min(input.observedAt, now) + leaseMs;
    // Record the edge before asynchronous lookup, including a short tombstone
    // for cleared publishers so a delayed start cannot revive a settled run.
    const lease: Lease = {
      externalSessionId: input.externalSessionId,
      sequence: input.sequence,
      expiresAt: input.working ? expiresAt : now + leaseMs,
      verified:
        input.working && current?.externalSessionId === input.externalSessionId
          ? current.verified
          : undefined
    };
    this.publishers.set(publisher, lease);
    if (!input.working) return;
    try {
      const sessionId = await this.scope.resolveSession(
        input.externalSessionId,
        signal
      );
      if (
        !signal.aborted &&
        this.refreshScope(Date.now()) &&
        this.publishers.get(publisher) === lease
      ) {
        lease.verified = sessionId ? { sessionId, expiresAt } : undefined;
      }
    } catch {
      // An unavailable owner lookup means liveness is unknown.
    }
  }

  async decorate(
    activity: FloatingKinActivity,
    signal: AbortSignal
  ): Promise<FloatingKinActivity> {
    if (!this.refreshScope(Date.now()) || this.publishers.size === 0)
      return activity;
    const conversations = await Promise.all(
      activity.conversations.map(async (row) => {
        if (row.client !== "pi" || !this.expiresAt(row.sessionId)) return row;
        try {
          if (
            !(await this.scope.allowsPersonalStatus(row.sessionId, signal)) ||
            signal.aborted
          )
            return row;
        } catch {
          return row;
        }
        if (!this.refreshScope(Date.now())) return row;
        const expiry = this.expiresAt(row.sessionId);
        return expiry
          ? { ...row, workingUntil: new Date(expiry).toISOString() }
          : row;
      })
    );
    return { ...activity, conversations };
  }

  private expiresAt(sessionId: string): number {
    let expiry = 0;
    for (const lease of this.publishers.values()) {
      if (lease.verified?.sessionId === sessionId)
        expiry = Math.max(expiry, lease.verified.expiresAt);
    }
    return expiry > Date.now() ? expiry : 0;
  }
}
