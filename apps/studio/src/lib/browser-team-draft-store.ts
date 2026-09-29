"use client";

import type {
  StudioTeamDraft,
  StudioTeamDraftAuthority
} from "./studio-collaboration-client";

type CipherRecord = {
  scope: string;
  teamScope: string;
  keyId: string;
  version: 1;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type KeyRecord = {
  scope: string;
  teamScope: string;
  keyId: string;
  key: CryptoKey;
};

type ScopeIndexRecord = {
  principalScope: string;
  authorizedTeamScopes: string[];
  teamScopes: string[];
};

export type BrowserTeamDraftStore = {
  load(authority: StudioTeamDraftAuthority): Promise<StudioTeamDraft | null>;
  save(
    authority: StudioTeamDraftAuthority,
    draft: StudioTeamDraft
  ): Promise<void>;
  delete(authority: StudioTeamDraftAuthority): Promise<void>;
  deleteTeam(authority: Omit<StudioTeamDraftAuthority, "threadId">): Promise<void>;
  retainAuthorizedTeams(input: {
    backendId: string;
    principalUserId: string;
    teamIds: string[];
  }): Promise<number>;
};

const databaseName = "koed-studio-private-team-drafts-v1";
const databaseVersion = 3;
const maxDraftBytes = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const validText = (value: unknown): value is string =>
  typeof value === "string" && encoder.encode(value).byteLength <= maxDraftBytes;

const validPendingSend = (value: unknown): value is StudioTeamDraft["pendingSend"] => {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.clientMessageId === "string" &&
    typeof pending.body === "string" &&
    encoder.encode(pending.body).byteLength <= maxDraftBytes &&
    typeof pending.createdAt === "string" &&
    Number.isFinite(Date.parse(pending.createdAt))
  );
};

const validReceiptAckPending = (value: unknown): value is NonNullable<StudioTeamDraft["receiptAckPending"]> | null | undefined => {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  const isUuid = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate);
  return isUuid(receipt.clientMessageId) && isUuid(receipt.messageId);
};

const assertAuthority = (
  authority: Omit<StudioTeamDraftAuthority, "threadId"> & { threadId?: string }
) => {
  if (
    !authority ||
    typeof authority.backendId !== "string" ||
    !authority.backendId ||
    !authority.principalUserId ||
    !authority.teamId ||
    ("threadId" in authority && typeof authority.threadId !== "string")
  ) {
    throw new Error("Team draft authority is invalid.");
  }
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digest = async (cryptoImpl: Crypto, value: unknown): Promise<string> =>
  toHex(
    new Uint8Array(
      await cryptoImpl.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(value))
      )
    )
  );

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });

const openDatabase = (indexedDb: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("drafts")) {
        const drafts = database.createObjectStore("drafts", { keyPath: "scope" });
        drafts.createIndex("teamScope", "teamScope");
      } else {
        const drafts = request.transaction!.objectStore("drafts");
        if (!drafts.indexNames.contains("teamScope")) drafts.createIndex("teamScope", "teamScope");
      }
      if (!database.objectStoreNames.contains("keys")) {
        const keys = database.createObjectStore("keys", { keyPath: "scope" });
        keys.createIndex("teamScope", "teamScope");
      } else {
        const keys = request.transaction!.objectStore("keys");
        if (!keys.indexNames.contains("teamScope")) keys.createIndex("teamScope", "teamScope");
      }
      if (!database.objectStoreNames.contains("scope-index")) {
        database.createObjectStore("scope-index", { keyPath: "principalScope" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked."));
  });

export const createBrowserTeamDraftStore = (input: {
  indexedDB?: IDBFactory;
  crypto?: Crypto;
} = {}): BrowserTeamDraftStore => {
  const indexedDb = input.indexedDB ?? globalThis.indexedDB;
  const cryptoImpl = input.crypto ?? globalThis.crypto;
  if (!indexedDb || !cryptoImpl?.subtle) {
    throw new Error("Encrypted browser draft storage is unavailable.");
  }
  const databasePromise = openDatabase(indexedDb);
  const queues = new Map<string, Promise<void>>();
  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try { return await operation(); } finally { release(); }
  };
  const serial = async <T>(scope: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(scope) ?? Promise.resolve();
    let resolveTail!: () => void;
    const tail = new Promise<void>((resolve) => (resolveTail = resolve));
    queues.set(scope, tail);
    await previous;
    try {
      return await operation();
    } finally {
      resolveTail();
      if (queues.get(scope) === tail) queues.delete(scope);
    }
  };
  const scopeFor = async (authority: StudioTeamDraftAuthority) => {
    assertAuthority(authority);
    const teamScope = await digest(cryptoImpl, [
      authority.backendId,
      authority.principalUserId,
      authority.teamId
    ]);
    const scope = await digest(cryptoImpl, [
      authority.backendId,
      authority.principalUserId,
      authority.teamId,
      authority.threadId
    ]);
    return { scope, teamScope };
  };
  const principalScopeFor = (backendId: string, principalUserId: string) =>
    digest(cryptoImpl, [backendId, principalUserId]);
  const keyFor = async (
    database: IDBDatabase,
    scope: string,
    teamScope: string
  ): Promise<KeyRecord> => {
    const candidate: KeyRecord = {
      scope,
      teamScope,
      keyId: crypto.randomUUID(),
      key: await cryptoImpl.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
      )
    };
    const write = database.transaction("keys", "readwrite");
    const store = write.objectStore("keys");
    const request = store.get(scope);
    let selected = candidate;
    request.onsuccess = () => {
      const existing = request.result as KeyRecord | undefined;
      if (existing) selected = existing;
      else store.put(candidate satisfies KeyRecord);
    };
    await transactionDone(write);
    return selected;
  };
  const aadFor = (scope: string) => encoder.encode(`koed:studio:team-draft:v1\n${scope}`);

  return {
    async load(authority) {
      const { scope, teamScope } = await scopeFor(authority);
      return await serial(scope, async () => {
        const database = await databasePromise;
        const principalScope = await principalScopeFor(authority.backendId, authority.principalUserId);
        const transaction = database.transaction(["drafts", "keys", "scope-index"], "readonly");
        const record = (await requestValue<CipherRecord | undefined>(
          transaction.objectStore("drafts").get(scope)
        )) ?? null;
        const storedKey = await requestValue<KeyRecord | undefined>(
          transaction.objectStore("keys").get(scope)
        );
        const index = await requestValue<ScopeIndexRecord | undefined>(
          transaction.objectStore("scope-index").get(principalScope)
        );
        await transactionDone(transaction);
        if (!index?.authorizedTeamScopes.includes(teamScope) || !record) return null;
        if (
          record.version !== 1 ||
          record.scope !== scope ||
          record.teamScope !== teamScope ||
          !storedKey ||
          storedKey.teamScope !== teamScope ||
          storedKey.keyId !== record.keyId
        ) {
          throw new Error("Encrypted Team draft record is invalid.");
        }
        const plaintext = await cryptoImpl.subtle.decrypt(
          { name: "AES-GCM", iv: record.iv, additionalData: aadFor(scope) },
          storedKey.key,
          record.ciphertext
        );
        const value: unknown = JSON.parse(decoder.decode(plaintext));
        if (
          !value ||
          typeof value !== "object" ||
          !validText((value as StudioTeamDraft).text) ||
          !validPendingSend((value as StudioTeamDraft).pendingSend) ||
          !validReceiptAckPending((value as StudioTeamDraft).receiptAckPending)
        ) {
          throw new Error("Decrypted Team draft is invalid.");
        }
        return value as StudioTeamDraft;
      });
    },

    async save(authority, draft) {
      if (!validText(draft?.text) || !validPendingSend(draft?.pendingSend) || !validReceiptAckPending(draft?.receiptAckPending)) {
        throw new Error("Team draft is invalid.");
      }
      const { scope, teamScope } = await scopeFor(authority);
      await mutate(() => serial(scope, async () => {
        const database = await databasePromise;
        if (draft.text.length === 0 && draft.pendingSend === null && !draft.receiptAckPending) {
          const transaction = database.transaction(["drafts", "keys"], "readwrite");
          transaction.objectStore("drafts").delete(scope);
          transaction.objectStore("keys").delete(scope);
          await transactionDone(transaction);
          return;
        }
        const keyRecord = await keyFor(database, scope, teamScope);
        const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
        const ciphertext = await cryptoImpl.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aadFor(scope) },
          keyRecord.key,
          encoder.encode(JSON.stringify({
            text: draft.text,
            pendingSend: draft.pendingSend,
            receiptAckPending: draft.receiptAckPending ?? null,
            updatedAt: new Date().toISOString()
          }))
        );
        const principalScope = await principalScopeFor(
          authority.backendId,
          authority.principalUserId
        );
        const transaction = database.transaction(["drafts", "keys", "scope-index"], "readwrite");
        const keyRequest = transaction.objectStore("keys").get(scope);
        const indexRequest = transaction.objectStore("scope-index").get(principalScope);
        let authorized = false;
        let readCount = 0;
        const commit = () => {
          readCount += 1;
          if (readCount !== 2) return;
          const latestKey = keyRequest.result as KeyRecord | undefined;
          const index = indexRequest.result as ScopeIndexRecord | undefined;
          if (!latestKey || latestKey.keyId !== keyRecord.keyId) return;
          if (!index?.authorizedTeamScopes.includes(teamScope)) {
            transaction.objectStore("drafts").delete(scope);
            transaction.objectStore("keys").delete(scope);
            return;
          }
          authorized = true;
          transaction.objectStore("drafts").put({ scope, teamScope, keyId: keyRecord.keyId, version: 1, iv: iv.buffer, ciphertext } satisfies CipherRecord);
          transaction.objectStore("scope-index").put({
            principalScope,
            authorizedTeamScopes: index.authorizedTeamScopes,
            teamScopes: [...new Set([...index.teamScopes, teamScope])]
          } satisfies ScopeIndexRecord);
        };
        keyRequest.onsuccess = commit;
        indexRequest.onsuccess = commit;
        await transactionDone(transaction);
        if (!authorized) throw new Error("Team draft scope is no longer authorized.");
      }));
    },

    async delete(authority) {
      const { scope } = await scopeFor(authority);
      await mutate(() => serial(scope, async () => {
        const database = await databasePromise;
        const transaction = database.transaction(["drafts", "keys"], "readwrite");
        transaction.objectStore("drafts").delete(scope);
        transaction.objectStore("keys").delete(scope);
        await transactionDone(transaction);
      }));
    },

    async deleteTeam(authority) {
      return await mutate(async () => {
        assertAuthority(authority);
        const teamScope = await digest(cryptoImpl, [authority.backendId, authority.principalUserId, authority.teamId]);
        const principalScope = await principalScopeFor(authority.backendId, authority.principalUserId);
        const database = await databasePromise;
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(["drafts", "keys", "scope-index"], "readwrite");
          const indexStore = transaction.objectStore("scope-index");
          const indexRequest = indexStore.get(principalScope);
          indexRequest.onsuccess = () => {
            const index = indexRequest.result as ScopeIndexRecord | undefined;
            for (const storeName of ["drafts", "keys"] as const) {
              const cursorRequest = transaction.objectStore(storeName).index("teamScope").openCursor(IDBKeyRange.only(teamScope));
              cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (cursor) { cursor.delete(); cursor.continue(); } };
            }
            if (index) indexStore.put({
              principalScope,
              authorizedTeamScopes: index.authorizedTeamScopes.filter((scope) => scope !== teamScope),
              teamScopes: index.teamScopes.filter((scope) => scope !== teamScope)
            } satisfies ScopeIndexRecord);
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error ?? new Error("Draft purge failed."));
          transaction.onabort = () => reject(transaction.error ?? new Error("Draft purge was aborted."));
        });
      });
    },

    async retainAuthorizedTeams(input) {
      return await mutate(async () => {
      if (
        typeof input.backendId !== "string" || !input.backendId ||
        typeof input.principalUserId !== "string" || !input.principalUserId ||
        !Array.isArray(input.teamIds) ||
        input.teamIds.length > 5_000 ||
        input.teamIds.some((teamId) => typeof teamId !== "string")
      ) {
        throw new Error("Authorized Team list is invalid.");
      }
      const allowed = new Set(
        await Promise.all(
          input.teamIds.map((teamId) =>
            digest(cryptoImpl, [input.backendId, input.principalUserId, teamId])
          )
        )
      );
      const principalScope = await principalScopeFor(input.backendId, input.principalUserId);
      const database = await databasePromise;
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(["drafts", "keys", "scope-index"], "readwrite");
        const indexStore = transaction.objectStore("scope-index");
        const indexRequest = indexStore.get(principalScope);
        let removedScopes: string[] = [];
        let pendingCursors = 0;
        let readyToWrite = false;
        const maybeCommitIndex = () => {
          if (!readyToWrite || pendingCursors > 0) return;
          indexStore.put({
            principalScope,
            authorizedTeamScopes: [...allowed],
            teamScopes: [...allowed]
          } satisfies ScopeIndexRecord);
        };
        indexRequest.onsuccess = () => {
          const index = indexRequest.result as ScopeIndexRecord | undefined;
          removedScopes = (index?.teamScopes ?? []).filter((scope) => !allowed.has(scope));
          pendingCursors = removedScopes.length * 2;
          readyToWrite = true;
          for (const scope of removedScopes) {
            for (const storeName of ["drafts", "keys"] as const) {
              const request = transaction.objectStore(storeName).index("teamScope").openCursor(IDBKeyRange.only(scope));
              request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) { cursor.delete(); cursor.continue(); }
                else { pendingCursors -= 1; maybeCommitIndex(); }
              };
            }
          }
          maybeCommitIndex();
        };
        transaction.oncomplete = () => resolve(removedScopes.length);
        transaction.onerror = () => reject(transaction.error ?? new Error("Draft reconciliation failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Draft reconciliation was aborted."));
      });
      });
    }
  };
};
