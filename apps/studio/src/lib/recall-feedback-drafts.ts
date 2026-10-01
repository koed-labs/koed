// prettier-ignore
// @ts-expect-error -- Node's native test runner needs the source extension.
import { createDesktopManagedChatRecoveryStore, hasDesktopManagedChatRecoveryBridge } from "./device-managed-chat-recovery.ts";

export type RecallFeedbackDraftIdentity = Readonly<{
  backendId: string;
  ownerId: string;
  executionId: string;
  messageId: string;
}>;

export type RecallFeedbackDraftStore = Readonly<{
  load: (identity: RecallFeedbackDraftIdentity) => Promise<string | null>;
  save: (
    identity: RecallFeedbackDraftIdentity,
    comment: string
  ) => Promise<void>;
  delete: (identity: RecallFeedbackDraftIdentity) => Promise<void>;
}>;

type CipherRecord = {
  scope: string;
  keyId: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type KeyRecord = { scope: string; keyId: string; key: CryptoKey };

const databaseName = "koed-studio-recall-feedback-drafts-v1";
const maxCommentBytes = 16 * 1024;
const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const answerId = new RegExp(`^(?:provider|agent):${uuid}$`);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("Encrypted feedback draft storage is unavailable.")
      );
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error("Encrypted feedback draft storage failed.")
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Encrypted feedback draft storage failed.")
      );
  });

const openDatabase = (indexedDb: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("drafts")) {
        database.createObjectStore("drafts", { keyPath: "scope" });
      }
      if (!database.objectStoreNames.contains("keys")) {
        database.createObjectStore("keys", { keyPath: "scope" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("Encrypted feedback draft storage is unavailable.")
      );
    request.onblocked = () =>
      reject(new Error("Encrypted feedback draft storage is blocked."));
  });

function assertIdentity(identity: RecallFeedbackDraftIdentity): void {
  if (
    !identity ||
    !identity.backendId.trim() ||
    !new RegExp(`^${uuid}$`).test(identity.ownerId) ||
    !new RegExp(`^${uuid}$`).test(identity.executionId) ||
    !answerId.test(identity.messageId)
  ) {
    throw new Error("Feedback draft identity is invalid.");
  }
}

function identityQueueKey(identity: RecallFeedbackDraftIdentity): string {
  assertIdentity(identity);
  return JSON.stringify([
    identity.backendId,
    identity.ownerId,
    identity.executionId,
    identity.messageId
  ]);
}

function assertComment(comment: string): void {
  if (
    typeof comment !== "string" ||
    comment.length > 4_000 ||
    encoder.encode(comment).byteLength > maxCommentBytes
  ) {
    throw new Error("Feedback comment is too long.");
  }
}

export function createRecallFeedbackDraftStore(
  input: {
    indexedDB?: IDBFactory;
    crypto?: Crypto;
  } = {}
): RecallFeedbackDraftStore {
  const indexedDb = input.indexedDB ?? globalThis.indexedDB;
  const cryptoImpl = input.crypto ?? globalThis.crypto;
  if (!indexedDb || !cryptoImpl?.subtle) {
    throw new Error("Encrypted feedback draft storage is unavailable.");
  }
  const databasePromise = openDatabase(indexedDb);
  const tails = new Map<string, Promise<void>>();
  const serial = async <T>(scope: string, operation: () => Promise<T>) => {
    const previous = tails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => (release = resolve));
    tails.set(scope, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(scope) === tail) tails.delete(scope);
    }
  };
  const scopeFor = async (identity: RecallFeedbackDraftIdentity) => {
    assertIdentity(identity);
    const digest = await cryptoImpl.subtle.digest(
      "SHA-256",
      encoder.encode(
        JSON.stringify([
          identity.backendId,
          identity.ownerId,
          identity.executionId,
          identity.messageId
        ])
      )
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  };
  const keyFor = async (
    database: IDBDatabase,
    scope: string
  ): Promise<KeyRecord> => {
    const candidate: KeyRecord = {
      scope,
      keyId: cryptoImpl.randomUUID(),
      key: await cryptoImpl.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      )
    };
    const transaction = database.transaction("keys", "readwrite");
    const store = transaction.objectStore("keys");
    const request = store.get(scope);
    let selected = candidate;
    request.onsuccess = () => {
      const existing = request.result as KeyRecord | undefined;
      if (existing) selected = existing;
      else store.put(candidate satisfies KeyRecord);
    };
    await transactionDone(transaction);
    return selected;
  };
  const aadFor = (scope: string) =>
    encoder.encode(`koed:studio:recall-feedback-draft:v1\n${scope}`);

  return {
    async load(identity) {
      const queueKey = identityQueueKey(identity);
      return await serial(queueKey, async () => {
        const scope = await scopeFor(identity);
        const database = await databasePromise;
        const transaction = database.transaction(
          ["drafts", "keys"],
          "readonly"
        );
        const record =
          (await requestValue<CipherRecord | undefined>(
            transaction.objectStore("drafts").get(scope)
          )) ?? null;
        const storedKey =
          (await requestValue<KeyRecord | undefined>(
            transaction.objectStore("keys").get(scope)
          )) ?? null;
        await transactionDone(transaction);
        if (!record) return null;
        if (
          record.scope !== scope ||
          !storedKey ||
          storedKey.scope !== scope ||
          storedKey.keyId !== record.keyId
        ) {
          throw new Error("Encrypted feedback draft is invalid.");
        }
        const plaintext = await cryptoImpl.subtle.decrypt(
          { name: "AES-GCM", iv: record.iv, additionalData: aadFor(scope) },
          storedKey.key,
          record.ciphertext
        );
        const comment = decoder.decode(plaintext);
        assertComment(comment);
        return comment;
      });
    },

    async save(identity, comment) {
      assertComment(comment);
      const queueKey = identityQueueKey(identity);
      await serial(queueKey, async () => {
        const scope = await scopeFor(identity);
        const database = await databasePromise;
        const keyRecord = await keyFor(database, scope);
        const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
        const ciphertext = await cryptoImpl.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aadFor(scope) },
          keyRecord.key,
          encoder.encode(comment)
        );
        const transaction = database.transaction(
          ["drafts", "keys"],
          "readwrite"
        );
        const keyRequest = transaction.objectStore("keys").get(scope);
        keyRequest.onsuccess = () => {
          const latestKey = keyRequest.result as KeyRecord | undefined;
          if (latestKey?.keyId !== keyRecord.keyId) {
            transaction.abort();
            return;
          }
          transaction.objectStore("drafts").put({
            scope,
            keyId: keyRecord.keyId,
            iv: iv.buffer,
            ciphertext
          } satisfies CipherRecord);
        };
        await transactionDone(transaction);
      });
    },

    async delete(identity) {
      const queueKey = identityQueueKey(identity);
      await serial(queueKey, async () => {
        const scope = await scopeFor(identity);
        const database = await databasePromise;
        const transaction = database.transaction(
          ["drafts", "keys"],
          "readwrite"
        );
        transaction.objectStore("drafts").delete(scope);
        transaction.objectStore("keys").delete(scope);
        await transactionDone(transaction);
      });
    }
  };
}

export function createDesktopRecallFeedbackDraftStore(): RecallFeedbackDraftStore | null {
  if (!hasDesktopManagedChatRecoveryBridge()) return null;
  return {
    async load(identity) {
      assertIdentity(identity);
      const scoped = createDesktopManagedChatRecoveryStore({
        ownerId: identity.ownerId,
        executionId: `feedback-draft:${identity.executionId}:${identity.messageId}`
      });
      if (!scoped) return null;
      const value = await scoped.hydrate();
      return value?.draft ?? null;
    },
    async save(identity, comment) {
      assertIdentity(identity);
      assertComment(comment);
      const scoped = createDesktopManagedChatRecoveryStore({
        ownerId: identity.ownerId,
        executionId: `feedback-draft:${identity.executionId}:${identity.messageId}`
      });
      if (!scoped)
        throw new Error("Encrypted feedback draft storage is unavailable.");
      scoped.write({ schemaVersion: 1, draft: comment });
      await scoped.flush?.();
    },
    async delete(identity) {
      assertIdentity(identity);
      const scoped = createDesktopManagedChatRecoveryStore({
        ownerId: identity.ownerId,
        executionId: `feedback-draft:${identity.executionId}:${identity.messageId}`
      });
      scoped?.clear();
      await scoped?.flush?.();
    }
  };
}
