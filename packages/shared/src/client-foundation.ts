import { z } from "zod";

export const portableClientBackendSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    displayName: z.string().trim().min(1).max(160),
    baseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    }),
    profile: z.enum([
      "developer",
      "local_personal",
      "private_vps",
      "team_self_hosted",
      "koed_managed_cloud"
    ]),
    capabilitySchemaVersion: z.number().int().safe().positive(),
    bindingGeneration: z.number().int().safe().positive()
  })
  .strict();
export type PortableClientBackend = z.infer<typeof portableClientBackendSchema>;

export const portableClientAuthoritySchema = z
  .object({
    backendId: z.string().trim().min(1).max(160),
    principalId: z.string().trim().min(1).max(160),
    credentialReference: z.string().trim().min(1).max(240),
    credentialGeneration: z.number().int().safe().positive(),
    authorityGeneration: z.number().int().safe().positive()
  })
  .strict();
export type PortableClientAuthority = z.infer<
  typeof portableClientAuthoritySchema
>;

export interface PortableClientSecureStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const authorityKey = (authority: PortableClientAuthority): string =>
  [
    authority.backendId,
    authority.principalId,
    authority.credentialGeneration,
    authority.authorityGeneration
  ]
    .map((value) => encodeURIComponent(String(value)))
    .join(":");

export class PortableClientEnvironmentRegistry {
  readonly #backends = new Map<string, PortableClientBackend>();
  #activeId: string | null = null;

  replace(backends: readonly unknown[], activeId: string | null): void {
    const parsed = backends.map((backend) =>
      portableClientBackendSchema.parse(backend)
    );
    const unique = new Map(parsed.map((backend) => [backend.id, backend]));
    if (unique.size !== parsed.length) {
      throw new TypeError("Portable client backend IDs must be unique");
    }
    if (activeId !== null && !unique.has(activeId)) {
      throw new TypeError("Portable client active backend is unavailable");
    }
    this.#backends.clear();
    for (const backend of parsed) this.#backends.set(backend.id, backend);
    this.#activeId = activeId;
  }

  active(): PortableClientBackend | null {
    return this.#activeId ? (this.#backends.get(this.#activeId) ?? null) : null;
  }

  list(): PortableClientBackend[] {
    return [...this.#backends.values()].map((backend) => ({ ...backend }));
  }
}

type CacheRecord<T> = {
  authorityGeneration: number;
  loadedAt: number;
  touchedAt: number;
  value: T;
};

export class PortableClientViewCache<T> {
  readonly #records = new Map<string, CacheRecord<T>>();

  constructor(
    private readonly policy: {
      maximumEntries: number;
      retentionMs: number;
      now?: () => number;
    }
  ) {
    if (
      !Number.isSafeInteger(policy.maximumEntries) ||
      policy.maximumEntries < 1 ||
      !Number.isSafeInteger(policy.retentionMs) ||
      policy.retentionMs < 1
    ) {
      throw new TypeError("Portable client cache policy is invalid");
    }
  }

  remember(key: string, authorityGeneration: number, value: T): void {
    const now = this.#now();
    this.#records.set(key, {
      authorityGeneration,
      loadedAt: now,
      touchedAt: now,
      value
    });
    this.#prune(now);
  }

  read(key: string, authorityGeneration: number): T | null {
    const record = this.#records.get(key);
    const now = this.#now();
    if (
      !record ||
      record.authorityGeneration !== authorityGeneration ||
      now - record.loadedAt > this.policy.retentionMs
    ) {
      this.#records.delete(key);
      return null;
    }
    record.touchedAt = now;
    return record.value;
  }

  invalidate(): void {
    this.#records.clear();
  }

  #now(): number {
    return (this.policy.now ?? Date.now)();
  }

  #prune(now: number): void {
    for (const [key, record] of this.#records) {
      if (now - record.loadedAt > this.policy.retentionMs) {
        this.#records.delete(key);
      }
    }
    const excess = this.#records.size - this.policy.maximumEntries;
    if (excess <= 0) return;
    const oldest = [...this.#records.entries()]
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
      .slice(0, excess);
    for (const [key] of oldest) this.#records.delete(key);
  }
}

const outboxRecordSchema = z
  .object({
    version: z.literal(1),
    authorityKey: z.string().min(1).max(1_024),
    id: z.string().trim().min(16).max(160),
    idempotencyKey: z.string().trim().min(16).max(160),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime({ offset: true }),
    attempt: z.number().int().safe().nonnegative(),
    state: z.enum(["queued", "dispatching", "indeterminate"]),
    payload: z.unknown()
  })
  .strict();
export type PortableClientOutboxRecord<T> = Omit<
  z.infer<typeof outboxRecordSchema>,
  "payload"
> & { payload: T };

export class PortableClientOutbox<T> {
  constructor(
    private readonly options: {
      namespace: string;
      store: PortableClientSecureStore;
      parsePayload(value: unknown): T;
      now?: () => Date;
    }
  ) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(options.namespace)) {
      throw new TypeError("Portable client outbox namespace is invalid");
    }
  }

  async enqueue(
    authorityValue: unknown,
    input: {
      id: string;
      idempotencyKey: string;
      requestDigest: string;
      payload: T;
    }
  ): Promise<PortableClientOutboxRecord<T>> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    const key = this.#key(authority, input.id);
    const existing = await this.#read(key);
    if (existing) {
      if (
        existing.idempotencyKey !== input.idempotencyKey ||
        existing.requestDigest !== input.requestDigest
      ) {
        throw new Error("Portable client outbox identity was reused");
      }
      return existing;
    }
    const record = this.#parse({
      version: 1,
      authorityKey: authorityKey(authority),
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      createdAt: (this.options.now ?? (() => new Date()))().toISOString(),
      attempt: 0,
      state: "queued",
      payload: input.payload
    });
    await this.options.store.put(key, JSON.stringify(record));
    return record;
  }

  async begin(
    authorityValue: unknown,
    id: string
  ): Promise<PortableClientOutboxRecord<T>> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    const key = this.#key(authority, id);
    const record = await this.#read(key);
    if (!record) throw new Error("Portable client outbox item is unavailable");
    if (record.state === "indeterminate") {
      throw new Error("Portable client outbox outcome is indeterminate");
    }
    const dispatching: PortableClientOutboxRecord<T> = {
      ...record,
      attempt: record.attempt + 1,
      state: "dispatching"
    };
    await this.options.store.put(key, JSON.stringify(dispatching));
    return dispatching;
  }

  async retry(
    authorityValue: unknown,
    id: string,
    outcomeKnownAbsent: boolean
  ): Promise<void> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    const key = this.#key(authority, id);
    const record = await this.#read(key);
    if (!record) return;
    const next: PortableClientOutboxRecord<T> = {
      ...record,
      state: outcomeKnownAbsent ? "queued" : "indeterminate"
    };
    await this.options.store.put(key, JSON.stringify(next));
  }

  async complete(authorityValue: unknown, id: string): Promise<void> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    await this.options.store.delete(this.#key(authority, id));
  }

  #key(authority: PortableClientAuthority, id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(id)) {
      throw new TypeError("Portable client outbox ID is invalid");
    }
    return `${this.options.namespace}:${authorityKey(authority)}:${id}`;
  }

  async #read(key: string): Promise<PortableClientOutboxRecord<T> | null> {
    const value = await this.options.store.get(key);
    return value === null ? null : this.#parse(JSON.parse(value));
  }

  #parse(value: unknown): PortableClientOutboxRecord<T> {
    const parsed = outboxRecordSchema.parse(value);
    return {
      ...parsed,
      payload: this.options.parsePayload(parsed.payload)
    };
  }
}

const draftRecordSchema = z
  .object({
    version: z.literal(1),
    authorityKey: z.string().min(1).max(1_024),
    scope: z.string().trim().min(1).max(512),
    value: z.string().max(262_144),
    updatedAt: z.iso.datetime({ offset: true })
  })
  .strict();

export class PortableClientDraftStore {
  constructor(
    private readonly options: {
      namespace: string;
      store: PortableClientSecureStore;
      maximumUtf8Bytes: number;
      now?: () => Date;
    }
  ) {
    if (
      !/^[A-Za-z0-9._-]{1,80}$/.test(options.namespace) ||
      !Number.isSafeInteger(options.maximumUtf8Bytes) ||
      options.maximumUtf8Bytes < 1
    ) {
      throw new TypeError("Portable client draft policy is invalid");
    }
  }

  async read(authorityValue: unknown, scope: string): Promise<string> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    const value = await this.options.store.get(this.#key(authority, scope));
    if (value === null) return "";
    const parsed = draftRecordSchema.parse(JSON.parse(value));
    if (
      parsed.authorityKey !== authorityKey(authority) ||
      parsed.scope !== scope
    ) {
      throw new Error("Portable client draft authority is stale");
    }
    return parsed.value;
  }

  async write(
    authorityValue: unknown,
    scope: string,
    value: string
  ): Promise<void> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    if (
      new TextEncoder().encode(value).byteLength > this.options.maximumUtf8Bytes
    ) {
      throw new TypeError("Portable client draft is too large");
    }
    const key = this.#key(authority, scope);
    if (!value) {
      await this.options.store.delete(key);
      return;
    }
    await this.options.store.put(
      key,
      JSON.stringify(
        draftRecordSchema.parse({
          version: 1,
          authorityKey: authorityKey(authority),
          scope,
          value,
          updatedAt: (this.options.now ?? (() => new Date()))().toISOString()
        })
      )
    );
  }

  async delete(authorityValue: unknown, scope: string): Promise<void> {
    const authority = portableClientAuthoritySchema.parse(authorityValue);
    await this.options.store.delete(this.#key(authority, scope));
  }

  #key(authority: PortableClientAuthority, scope: string): string {
    if (!scope.trim() || scope.length > 512 || /[\r\n\0]/.test(scope)) {
      throw new TypeError("Portable client draft scope is invalid");
    }
    return `${this.options.namespace}:${authorityKey(authority)}:${encodeURIComponent(scope)}`;
  }
}

export const portableClientNotificationSchema = z
  .object({
    version: z.literal(1),
    backendId: z.string().trim().min(1).max(160),
    principalId: z.string().trim().min(1).max(160),
    eventId: z.string().trim().min(1).max(240),
    resourceKind: z.enum([
      "conversation",
      "thread",
      "approval",
      "mention",
      "sync"
    ]),
    resourceId: z.string().trim().min(1).max(240),
    badgeDelta: z.number().int().safe().min(0).max(1_000),
    occurredAt: z.iso.datetime({ offset: true })
  })
  .strict();
export type PortableClientNotification = z.infer<
  typeof portableClientNotificationSchema
>;
