import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type EnrollmentFenceRegistration = {
  instanceId: string;
  epochId: string;
  owner: string;
};

export type EnrollmentFenceRequest = EnrollmentFenceRegistration & {
  operationId: string;
};

export type EnrollmentFenceErrorCode =
  | "invalid_input"
  | "instance_mismatch"
  | "unknown_epoch"
  | "unknown_operation"
  | "owner_mismatch"
  | "capacity_exceeded"
  | "fenced";

export class EnrollmentFenceError extends Error {
  constructor(public readonly code: EnrollmentFenceErrorCode) {
    super(`Enrollment fence: ${code}`);
    this.name = "EnrollmentFenceError";
  }
}

type Entry = { fenced: boolean; active: number; key: string; epoch: Epoch };
type OwnerCounts = {
  epochs: number;
  operations: number;
  active: number;
  operationCandidates: Set<Entry>;
  epochCandidates: Set<Epoch>;
  operationEpochCandidates: Set<Epoch>;
};
type Epoch = {
  id: string;
  owner: string;
  candidates: Set<Entry>;
  expires: number;
  fenced: boolean;
  active: number;
  operations: Map<string, Entry>;
};
type Options = {
  now?: () => number;
  epochLifetimeMs?: number;
  maxEpochs?: number;
  maxEpochsPerOwner?: number;
  maxOperations?: number;
  maxOperationsPerOwner?: number;
  maxActive?: number;
  maxActivePerOwner?: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const epochPattern = /^[0-9a-f]{32}-[0-9a-f]{16}$/;
const validUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);
const validOwner = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && value.trim().length > 0;

/**
 * Process-local coordination only; caller authenticates owner. Instance and
 * UUID is cryptographically random; operation UUIDs are unique per instance,
 * not authorization credentials. A lost registration response is uncertain; retrying creates
 * a distinct operation and cannot prove the lost operation drained. An epoch
 * barrier covers lost registrations, but not an unknown createEpoch outcome.
 * Integration must track pending createEpoch requests and never report safe
 * shutdown while any creation outcome is unknown. Unknown or evicted state,
 * restart, and instance mismatch remain uncertainty, not proof of drain.
 * Callers must rate-limit requests: capacity bounds do not bound request CPU.
 */
export class EnrollmentFence {
  readonly instanceId: string;
  private readonly epochs = new Map<string, Epoch>();
  private readonly owners = new Map<string, OwnerCounts>();
  private readonly operationCandidates = new Set<Entry>();
  private readonly epochCandidates = new Set<Epoch>();
  private readonly operationEpochCandidates = new Set<Epoch>();
  private operationSequence = 0n;
  private operations = 0;
  private active = 0;
  private sequence = 0n;
  private lastNow = -Infinity;
  private readonly options: Required<Options>;

  constructor(options: Options = {}) {
    this.instanceId = randomUUID();
    this.options = {
      now: performance.now.bind(performance),
      epochLifetimeMs: 600_000,
      maxEpochs: 10_000,
      maxEpochsPerOwner: 100,
      maxOperations: 10_000,
      maxOperationsPerOwner: 100,
      maxActive: 10_000,
      maxActivePerOwner: 100,
      ...options
    };
    for (const [key, value] of Object.entries(this.options)) {
      if (
        key !== "now" &&
        (typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value <= 0)
      )
        throw new EnrollmentFenceError("invalid_input");
    }
    if (typeof this.options.now !== "function")
      throw new EnrollmentFenceError("invalid_input");
  }

  private time(): number {
    const now = this.options.now();
    if (!Number.isFinite(now) || now < this.lastNow)
      throw new EnrollmentFenceError("invalid_input");
    this.lastNow = now;
    return now;
  }

  private indexOperation(entry: Entry): void {
    if (!entry.fenced || entry.active !== 0) return;
    entry.epoch.candidates.add(entry);
    this.operationCandidates.add(entry);
    this.owners.get(entry.epoch.owner)!.operationCandidates.add(entry);
  }

  private removeOperationCandidate(entry: Entry): void {
    entry.epoch.candidates.delete(entry);
    this.operationCandidates.delete(entry);
    this.owners.get(entry.epoch.owner)!.operationCandidates.delete(entry);
  }

  private indexEpoch(epoch: Epoch): void {
    if (!epoch.fenced || epoch.active !== 0) return;
    this.epochCandidates.add(epoch);
    const owner = this.owners.get(epoch.owner)!;
    owner.epochCandidates.add(epoch);
    if (epoch.operations.size > 0) {
      this.operationEpochCandidates.add(epoch);
      owner.operationEpochCandidates.add(epoch);
    }
  }

  private removeEpoch(epoch: Epoch): void {
    const owner = this.owners.get(epoch.owner)!;
    for (const entry of epoch.candidates) this.removeOperationCandidate(entry);
    this.epochCandidates.delete(epoch);
    owner.epochCandidates.delete(epoch);
    this.operationEpochCandidates.delete(epoch);
    owner.operationEpochCandidates.delete(epoch);
    this.operations -= epoch.operations.size;
    owner.operations -= epoch.operations.size;
    if (--owner.epochs === 0) this.owners.delete(epoch.owner);
    this.epochs.delete(epoch.id);
  }

  private removeOperation(entry: Entry): void {
    this.removeOperationCandidate(entry);
    entry.epoch.operations.delete(entry.key);
    this.operations--;
    const owner = this.owners.get(entry.epoch.owner)!;
    owner.operations--;
    if (entry.epoch.operations.size === 0) {
      this.operationEpochCandidates.delete(entry.epoch);
      owner.operationEpochCandidates.delete(entry.epoch);
    }
  }

  private prune(now: number): void {
    for (const epoch of this.epochs.values()) {
      if (now >= epoch.expires && epoch.active === 0) this.removeEpoch(epoch);
    }
  }

  createEpoch(owner: string): string {
    if (!validOwner(owner)) throw new EnrollmentFenceError("invalid_input");
    const now = this.time();
    if (
      this.sequence >= 0xffffffffffffffffn ||
      !Number.isFinite(now + this.options.epochLifetimeMs)
    )
      throw new EnrollmentFenceError("capacity_exceeded");
    this.prune(now);
    const ownerFull =
      (this.owners.get(owner)?.epochs ?? 0) >= this.options.maxEpochsPerOwner;
    const globalFull = this.epochs.size >= this.options.maxEpochs;
    const candidate = ownerFull
      ? this.owners.get(owner)!.epochCandidates.values().next().value
      : globalFull
        ? this.epochCandidates.values().next().value
        : undefined;
    if ((ownerFull || globalFull) && !candidate)
      throw new EnrollmentFenceError("capacity_exceeded");
    if (candidate) this.removeEpoch(candidate);
    const id = `${randomBytes(16).toString("hex")}-${(++this.sequence).toString(16).padStart(16, "0")}`;
    this.epochs.set(id, {
      id,
      owner,
      candidates: new Set(),
      expires: now + this.options.epochLifetimeMs,
      fenced: false,
      active: 0,
      operations: new Map()
    });
    const counts = this.owners.get(owner) ?? {
      epochs: 0,
      operations: 0,
      active: 0,
      operationCandidates: new Set<Entry>(),
      epochCandidates: new Set<Epoch>(),
      operationEpochCandidates: new Set<Epoch>()
    };
    counts.epochs++;
    this.owners.set(owner, counts);
    return id;
  }

  private lookupEpoch(request: EnrollmentFenceRegistration): Epoch {
    if (
      !request ||
      !validUuid(request.instanceId) ||
      typeof request.epochId !== "string" ||
      !epochPattern.test(request.epochId) ||
      !validOwner(request.owner)
    )
      throw new EnrollmentFenceError("invalid_input");
    if (request.instanceId.toLowerCase() !== this.instanceId)
      throw new EnrollmentFenceError("instance_mismatch");
    const epoch = this.epochs.get(request.epochId);
    if (!epoch) throw new EnrollmentFenceError("unknown_epoch");
    if (epoch.owner !== request.owner)
      throw new EnrollmentFenceError("owner_mismatch");
    return epoch;
  }

  register(request: EnrollmentFenceRegistration): string {
    const epoch = this.lookupEpoch(request);
    const now = this.time();
    if (now >= epoch.expires || epoch.fenced)
      throw new EnrollmentFenceError("fenced");
    if (this.operationSequence >= (1n << 122n) - 1n)
      throw new EnrollmentFenceError("capacity_exceeded");
    if (
      this.operations >= this.options.maxOperations ||
      this.owners.get(epoch.owner)!.operations >=
        this.options.maxOperationsPerOwner
    )
      this.prune(now);
    const counts = this.owners.get(epoch.owner)!;
    const ownerFull = counts.operations >= this.options.maxOperationsPerOwner;
    const globalFull = this.operations >= this.options.maxOperations;
    const candidate = ownerFull
      ? counts.operationCandidates.values().next().value
      : globalFull
        ? this.operationCandidates.values().next().value
        : undefined;
    const epochCandidate =
      !candidate && (ownerFull || globalFull)
        ? (ownerFull
            ? counts.operationEpochCandidates
            : this.operationEpochCandidates
          )
            .values()
            .next().value
        : undefined;
    if ((ownerFull || globalFull) && !candidate && !epochCandidate)
      throw new EnrollmentFenceError("capacity_exceeded");
    if (this.time() >= epoch.expires) throw new EnrollmentFenceError("fenced");
    if (candidate) this.removeOperation(candidate);
    if (epochCandidate) this.removeEpoch(epochCandidate);
    const value = ++this.operationSequence;
    const high = (value >> 74n).toString(16).padStart(12, "0");
    const middle = ((value >> 62n) & 0xfffn).toString(16).padStart(3, "0");
    const low = (value & ((1n << 60n) - 1n)).toString(16).padStart(15, "0");
    const variant = (8 + Number((value >> 60n) & 3n)).toString(16);
    const key = `${high.slice(0, 8)}-${high.slice(8)}-4${middle}-${variant}${low.slice(0, 3)}-${low.slice(3)}`;
    epoch.operations.set(key, { fenced: false, active: 0, key, epoch });
    this.operations++;
    counts.operations++;
    return key;
  }

  private entry(epoch: Epoch, operationId: string): Entry {
    if (!validUuid(operationId))
      throw new EnrollmentFenceError("invalid_input");
    const entry = epoch.operations.get(operationId.toLowerCase());
    if (!entry) throw new EnrollmentFenceError("unknown_operation");
    return entry;
  }

  enter(request: EnrollmentFenceRequest): () => void {
    const epoch = this.lookupEpoch(request);
    const entry = this.entry(epoch, request.operationId);
    if (this.time() >= epoch.expires || epoch.fenced || entry.fenced)
      throw new EnrollmentFenceError("fenced");
    const counts = this.owners.get(epoch.owner)!;
    if (
      this.active >= this.options.maxActive ||
      counts.active >= this.options.maxActivePerOwner
    )
      throw new EnrollmentFenceError("capacity_exceeded");
    if (this.time() >= epoch.expires) throw new EnrollmentFenceError("fenced");
    entry.active++;
    epoch.active++;
    this.active++;
    counts.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        entry.active--;
        epoch.active--;
        this.active--;
        counts.active--;
        this.indexOperation(entry);
        this.indexEpoch(epoch);
      }
    };
  }

  /** Atomically close the epoch and poll all admitted work. */
  fenceEpochAndDrain(
    request: EnrollmentFenceRegistration
  ): "pending" | "drained" {
    const epoch = this.lookupEpoch(request);
    epoch.fenced = true;
    this.indexEpoch(epoch);
    return epoch.active === 0 ? "drained" : "pending";
  }

  /** Unknown or evicted state is uncertainty, never proof of drain. */
  fenceAndDrain(request: EnrollmentFenceRequest): "pending" | "drained" {
    const epoch = this.lookupEpoch(request);
    const entry = this.entry(epoch, request.operationId);
    entry.fenced = true;
    this.indexOperation(entry);
    return entry.active === 0 ? "drained" : "pending";
  }
}
