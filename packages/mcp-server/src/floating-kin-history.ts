import { createHash } from "node:crypto";
import type {
  FloatingKinEvidence,
  FloatingKinSummaryOpen,
  FloatingKinSummaryRequest,
  FloatingKinSummaryTarget
} from "@koed-labs/shared";
import type { BlockingAnswerAdmission } from "./answer-admission.js";
import { MemoryApiError, type MemoryApiClient } from "./index.js";

const maxEntries = 32;
const ttlMs = 30 * 60_000;
const lookupTimeoutMs = 5_000;

type OpenSummary = NonNullable<FloatingKinSummaryOpen>;
type Fingerprints = ReadonlyMap<string, string>;
type Entry = {
  request: FloatingKinSummaryRequest;
  result: OpenSummary["result"];
  fingerprints: Fingerprints;
  expiresAt: number;
};

export function fingerprintFloatingKinEvidence({ items }: FloatingKinEvidence) {
  return new Map(
    items.map(({ id, sessionId, kind, occurredAt, text }) => [
      id,
      createHash("sha256")
        .update(JSON.stringify([sessionId, kind, occurredAt, text]))
        .digest("hex")
    ])
  );
}

export function matchesFloatingKinEvidence(
  expected: Fingerprints,
  evidence: FloatingKinEvidence
) {
  const actual = fingerprintFloatingKinEvidence(evidence);
  return (
    evidence.items.length === expected.size &&
    actual.size === expected.size &&
    [...expected].every(([id, digest]) => actual.get(id) === digest)
  );
}

export class FloatingKinHistory {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { active: number; latestSuccess: number }
  >();
  private readonly expiryTimer = setInterval(
    () => this.purge(),
    60_000
  ).unref();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly client: MemoryApiClient,
    private readonly admission: BlockingAnswerAdmission,
    private readonly runtimeAuthorization: string
  ) {}

  // Only admitted summary requests hold a ticket. Keep the watermark until
  // all overlapping requests finish, even if their cache entry is evicted.
  begin(request: FloatingKinSummaryRequest) {
    const order = ++this.sequence;
    const pending = this.pending.get(request.sessionId) ?? {
      active: 0,
      latestSuccess: 0
    };
    this.pending.set(request.sessionId, pending);
    pending.active++;
    return {
      remember: (
        owner: string,
        result: OpenSummary["result"],
        fingerprints: Fingerprints,
        signal: AbortSignal
      ) => {
        if (this.closed || signal.aborted || order <= pending.latestSuccess)
          return;
        const key = JSON.stringify([owner, request.sessionId]);
        pending.latestSuccess = order;
        this.purge();
        this.entries.delete(key);
        this.entries.set(key, {
          request,
          result,
          fingerprints,
          expiresAt: Date.now() + ttlMs
        });
        if (this.entries.size > maxEntries)
          this.entries.delete(this.entries.keys().next().value!);
      },
      finish: () => {
        if (--pending.active === 0) this.pending.delete(request.sessionId);
      }
    };
  }

  async open(
    target: FloatingKinSummaryTarget,
    callerSignal: AbortSignal
  ): Promise<FloatingKinSummaryOpen> {
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(lookupTimeoutMs)
    ]);
    let release: (() => void) | undefined;
    let key: string | undefined;
    let entry: Entry | undefined;
    try {
      this.purge();
      if (!this.entries.size || this.closed) return null;
      release = await this.admission.acquire(signal);
      const owner = await this.client.readFloatingKinHistoryOwner(
        this.runtimeAuthorization,
        signal
      );
      if (!owner) return null;
      key = JSON.stringify([owner, target.sessionId]);
      entry = this.entries.get(key);
      if (
        !entry ||
        (entry.request.action === "project" &&
          entry.request.projectId !== target.projectId)
      )
        return null;
      const evidence = await this.client.readFloatingKinEvidence(
        { ...entry.request, evidenceIds: [...entry.fingerprints.keys()] },
        this.runtimeAuthorization,
        signal
      );
      signal.throwIfAborted();
      if (this.entries.get(key) !== entry) return null;
      if (
        entry.expiresAt <= Date.now() ||
        !matchesFloatingKinEvidence(entry.fingerprints, evidence)
      ) {
        this.entries.delete(key);
        return null;
      }
      return { action: entry.request.action, result: entry.result };
    } catch (error) {
      if (
        !signal.aborted &&
        key &&
        entry &&
        this.entries.get(key) === entry &&
        error instanceof MemoryApiError &&
        error.status !== undefined &&
        [401, 403, 404].includes(error.status)
      )
        this.entries.delete(key);
      return null;
    } finally {
      release?.();
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.expiryTimer);
    this.entries.clear();
    this.pending.clear();
  }

  private purge() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
